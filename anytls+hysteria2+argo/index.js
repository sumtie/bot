'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const VERSION = '1.14.4';
const PKG = `sing-box-${VERSION}-linux-amd64-musl`;
const URL_TGZ = `https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${PKG}.tar.gz`;

const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'sing-box');
const CFG = path.join(DIR, 'config.json');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const NODES = path.join(DIR, 'nodes.txt');
const SB_LOG = path.join(DIR, 'sing-box.log');

const SNI = process.env.SNI || 'bing.com';
const PORT = parseInt(process.env.SERVER_PORT || '8443', 10);
const PASSWORD = process.env.PASSWORD || crypto.randomBytes(12).toString('base64url');

const ARGO_TOKEN = process.env.ARGO_TOKEN || '';
const ARGO_PORT = parseInt(process.env.ARGO_PORT || '8080', 10);
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_PROTOCOL = process.env.ARGO_PROTOCOL || ''; // quic | http2
const UUID = process.env.UUID || crypto.randomUUID();
const WS_PATH = '/' + crypto.randomBytes(8).toString('hex');
const ARGO_ON = !!ARGO_TOKEN;

let argoDomain = ARGO_DOMAIN;

fs.mkdirSync(DIR, { recursive: true });

function download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 8) return reject(new Error('重定向过多'));
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'node' } }, res => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code)) {
        res.resume();
        return resolve(download(res.headers.location, dest, depth + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
      f.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureBinary() {
  if (fs.existsSync(BIN)) return;
  const tmp = path.join(DIR, 'sing-box.tar.gz');
  console.log('[+] 下载 sing-box', VERSION);
  await download(URL_TGZ, tmp);
  execFileSync('tar', ['-xzf', tmp, '-C', DIR, '--strip-components=1']);
  fs.rmSync(tmp, { force: true });
  fs.chmodSync(BIN, 0o755);
  execFileSync(BIN, ['version'], { stdio: 'ignore' });
}

function hasOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function makeCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return 'existing';
  if (hasOpenssl()) {
    try {
      execFileSync('openssl', ['ecparam', '-genkey', '-name', 'prime256v1', '-out', KEY]);
      execFileSync('openssl', ['req', '-new', '-x509', '-days', '3650', '-key', KEY, '-out', CERT, '-subj', `/CN=${SNI}`]);
      return 'openssl';
    } catch (e) {
      console.log('[!] openssl 失败，改用 selfsigned:', e.message);
    }
  }
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: SNI }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }]
  });
  fs.writeFileSync(CERT, pems.cert);
  fs.writeFileSync(KEY, pems.private);
  return 'selfsigned';
}

function certFingerprint() {
  const der = Buffer.from(
    fs.readFileSync(CERT, 'utf8').replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    'base64'
  );
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');
}

function getHost() {
  if (process.env.SERVER_HOST) return Promise.resolve(process.env.SERVER_HOST);
  return new Promise(resolve => {
    const req = https.get('https://api.ipify.org', res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d.trim() || '127.0.0.1'));
    });
    req.on('error', () => resolve('127.0.0.1'));
    req.setTimeout(5000, () => { req.destroy(); resolve('127.0.0.1'); });
  });
}

function buildConfig() {
  const tls = {
    enabled: true,
    server_name: SNI,
    certificate_path: CERT,
    key_path: KEY
  };
  const inbounds = [
    {
      type: 'hysteria2',
      tag: 'hysteria2',
      listen: '::',
      listen_port: PORT,
      users: [{ password: PASSWORD }],
      masquerade: `https://${SNI}`,
      tls: { ...tls, alpn: ['h3'] }
    },
    {
      type: 'anytls',
      tag: 'anytls',
      listen: '::',
      listen_port: PORT,
      users: [{ password: PASSWORD }],
      tls
    }
  ];
  const route = { rules: [] };

  if (ARGO_ON) {
    inbounds.push({
      type: 'vless',
      tag: 'vless-ws',
      listen: '127.0.0.1',
      listen_port: ARGO_PORT,
      users: [{ name: 'argo', uuid: UUID }],
      transport: { type: 'ws', path: WS_PATH }
    });

    const cf = { type: 'cloudflared', tag: 'argo', token: ARGO_TOKEN, ha_connections: 2 };
    if (ARGO_PROTOCOL) cf.protocol = ARGO_PROTOCOL;
    inbounds.push(cf);

    // 隧道流量统一落到本地 vless-ws
    route.rules.push({
      inbound: ['argo'],
      action: 'route',
      outbound: 'direct',
      override_address: '127.0.0.1',
      override_port: ARGO_PORT
    });
  }

  return {
    log: { level: 'info', timestamp: true },
    inbounds,
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route
  };
}

function buildNodes(host, fp) {
  const h = host.includes(':') ? `[${host}]` : host;
  const q = `insecure=1&sni=${SNI}&pinSHA256=${fp}`;
  const pw = encodeURIComponent(PASSWORD);
  const list = [
    `hysteria2://${pw}@${h}:${PORT}?${q}&alpn=h3#hy2-${h}-${PORT}`,
    `anytls://${pw}@${h}:${PORT}?${q}#anytls-${h}-${PORT}`
  ];
  if (ARGO_ON && argoDomain) {
    const p = encodeURIComponent(WS_PATH);
    list.push(`vless://${UUID}@${argoDomain}:443?encryption=none&security=tls&sni=${argoDomain}&fp=chrome&type=ws&host=${argoDomain}&path=${p}&allowInsecure=1#vless-ws-${argoDomain}`);
  }
  return list;
}

let baseHost = '127.0.0.1';
let fingerprint = '';

function writeNodes() {
  const nodes = buildNodes(baseHost, fingerprint);
  fs.writeFileSync(NODES, nodes.join('\n') + '\n');
  return nodes;
}

function run() {
  const logStream = fs.createWriteStream(SB_LOG, { flags: 'a' });
  const p = spawn(BIN, ['run', '-c', CFG], { stdio: ['ignore', 'pipe', 'pipe'] });

  const handle = buf => {
    const s = buf.toString();
    logStream.write(s);
    process.stdout.write(s);
    if (ARGO_ON && !argoDomain) {
      const m = s.match(/hostname["\s:=]+([a-z0-9][a-z0-9.-]+\.[a-z]{2,})/i);
      if (m) {
        argoDomain = m[1];
        console.log('[+] 从日志解析到隧道域名:', argoDomain);
        writeNodes();
      }
    }
  };
  p.stdout.on('data', handle);
  p.stderr.on('data', handle);

  p.on('exit', (code, sig) => {
    console.log(`[!] sing-box 退出 code=${code} sig=${sig}，3s 后重启`);
    setTimeout(run, 3000);
  });
}

(async () => {
  await ensureBinary();

  const mode = makeCert();
  fingerprint = certFingerprint();
  fs.writeFileSync(CFG, JSON.stringify(buildConfig(), null, 2));

  baseHost = await getHost();
  const nodes = writeNodes();

  console.log('----------------------------------------');
  console.log('端口        :', PORT, '(UDP hysteria2 / TCP anytls)');
  console.log('密码        :', PASSWORD);
  console.log('SNI         :', SNI);
  console.log('证书来源    :', mode);
  console.log('SHA-256     :', fingerprint);
  if (ARGO_ON) {
    console.log('Argo 本地   :', `127.0.0.1:${ARGO_PORT}  ws=${WS_PATH}`);
    console.log('UUID        :', UUID);
    console.log('Argo 域名   :', argoDomain || '(未填写 ARGO_DOMAIN，等待日志解析)');
  }
  console.log('节点链接    :');
  nodes.forEach(n => console.log('  ' + n));
  console.log('文件目录    :', DIR);
  console.log('----------------------------------------');

  run();
})();