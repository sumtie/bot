'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const SB_VER = '1.14.4';
const ARCH = { x64: 'amd64', arm64: 'arm64' }[os.arch()];
if (os.platform() !== 'linux' || !ARCH) {
  console.error('仅支持 Linux amd64 / arm64');
  process.exit(1);
}

const DIR = path.join(__dirname, '.npm');
fs.mkdirSync(DIR, { recursive: true });

const STATE_FILE = path.join(DIR, 'state.json');
const CERT_FILE = path.join(DIR, 'cert.pem');
const KEY_FILE = path.join(DIR, 'key.pem');
const CFG_FILE = path.join(DIR, 'config.json');
const LINKS_FILE = path.join(DIR, 'links.txt');
const SB_BIN = path.join(DIR, 'sing-box');
const CF_BIN = path.join(DIR, 'cloudflared');

const SHOW_LOG = String(process.env.SHOW_LOG || '').toLowerCase() === 'true';
const HY2_PORT = Number(process.env.HY2_PORT) || 0;
const TUIC_PORT = Number(process.env.TUIC_PORT) || 0;
const ANYTLS_PORT = Number(process.env.ANYTLS_PORT) || 0;
const ARGO_PORT = Number(process.env.ARGO_PORT) || 8080;
const ARGO_TOKEN = process.env.ARGO_TOKEN || '';
const ARGO_DOMAIN = process.env.ARGO_DOMIAN || '';

if (HY2_PORT && TUIC_PORT && HY2_PORT === TUIC_PORT) {
  console.error('HY2_PORT 与 TUIC_PORT 不能相同');
  process.exit(1);
}

// GOMEMLIMIT: sing-box 64MiB + cloudflared 56MiB，合计 <= 128MB
const MEM_SB = { GOMEMLIMIT: '64MiB', GOGC: '30' };
const MEM_CF = { GOMEMLIMIT: '56MiB', GOGC: '30' };

const log = (...a) => console.log(...a);

function download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 8) return reject(new Error('重定向过多'));
    https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} -> HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureSingBox() {
  if (fs.existsSync(SB_BIN)) return SB_BIN;
  const tgz = path.join(DIR, 'sb.tar.gz');
  const dir = `sing-box-${SB_VER}-linux-${ARCH}-musl`;
  await download(
    `https://github.com/SagerNet/sing-box/releases/download/v${SB_VER}/${dir}.tar.gz`,
    tgz
  );
  execFileSync('tar', ['-xzf', tgz, '-C', DIR]);
  fs.renameSync(path.join(DIR, dir, 'sing-box'), SB_BIN);
  fs.rmSync(path.join(DIR, dir), { recursive: true, force: true });
  fs.rmSync(tgz, { force: true });
  fs.chmodSync(SB_BIN, 0o755);
  return SB_BIN;
}

async function ensureCloudflared() {
  if (fs.existsSync(CF_BIN)) return CF_BIN;
  await download(
    `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`,
    CF_BIN
  );
  fs.chmodSync(CF_BIN, 0o755);
  return CF_BIN;
}

function ensureCert() {
  if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
    execFileSync('openssl', ['ecparam', '-genkey', '-name', 'prime256v1', '-out', KEY_FILE]);
    execFileSync('openssl', [
      'req', '-new', '-x509', '-key', KEY_FILE, '-out', CERT_FILE,
      '-days', '3650', '-subj', '/CN=bing.com',
      '-addext', 'subjectAltName=DNS:bing.com'
    ]);
    fs.chmodSync(KEY_FILE, 0o600);
  }
  // 形如 61:BC:FD:70:...（大写、冒号分隔）
  return new crypto.X509Certificate(fs.readFileSync(CERT_FILE)).fingerprint256;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function getIp() {
  if (process.env.NODE_IP) return Promise.resolve(process.env.NODE_IP);
  return new Promise((resolve) => {
    https.get('https://api.ipify.org', (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d.trim() || '127.0.0.1'));
    }).on('error', () => resolve('127.0.0.1'));
  });
}

const children = [];
function run(name, bin, args, env, onData) {
  const child = spawn(bin, args, {
    cwd: DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const handle = (buf) => {
    const s = buf.toString();
    if (SHOW_LOG) process.stdout.write(`[${name}] ${s}`);
    if (onData) onData(s);
  };
  child.stdout.on('data', handle);
  child.stderr.on('data', handle);
  child.on('exit', (code) => log(`[${name}] 退出 code=${code}`));
  children.push(child);
  return child;
}

function cleanup() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

const tls = (alpn) => ({
  enabled: true,
  server_name: 'bing.com',
  alpn,
  certificate_path: CERT_FILE,
  key_path: KEY_FILE
});

(async () => {
  const sbBin = await ensureSingBox();
  const cfBin = await ensureCloudflared();
  const fp = ensureCert();

  const state = loadState();
  if (!state.password) state.password = process.env.PASSWORD || crypto.randomBytes(16).toString('base64url');
  if (!state.uuid) state.uuid = crypto.randomUUID();
  if (!state.wsPath) state.wsPath = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

  const inbounds = [];

  if (HY2_PORT) {
    inbounds.push({
      type: 'hysteria2',
      tag: 'hy2-in',
      listen: '::',
      listen_port: HY2_PORT,
      users: [{ password: state.password }],
      tls: tls(['h3'])
    });
  }

  if (TUIC_PORT) {
    inbounds.push({
      type: 'tuic',
      tag: 'tuic-in',
      listen: '::',
      listen_port: TUIC_PORT,
      users: [{ uuid: state.uuid, password: state.password }],
      congestion_control: 'bbr',
      tls: tls(['h3'])
    });
  }

  if (ANYTLS_PORT) {
    inbounds.push({
      type: 'anytls',
      tag: 'anytls-in',
      listen: '::',
      listen_port: ANYTLS_PORT,
      users: [{ password: state.password }],
      tls: tls(['h2', 'http/1.1'])
    });
  }

  // vless + ws，只监听本地，由 cloudflared 回源
  inbounds.push({
    type: 'vless',
    tag: 'vless-in',
    listen: '127.0.0.1',
    listen_port: ARGO_PORT,
    users: [{ uuid: state.uuid }],
    transport: {
      type: 'ws',
      path: `/${state.wsPath}`,
      early_data_header_name: 'Sec-WebSocket-Protocol'
    }
  });

  const config = {
    log: SHOW_LOG
      ? { level: 'info', timestamp: true }
      : { disabled: true },
    inbounds,
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: {
      rules: [{ action: 'sniff' }],
      final: 'direct'
    }
  };

  fs.writeFileSync(CFG_FILE, JSON.stringify(config, null, 2));
  execFileSync(sbBin, ['check', '-c', CFG_FILE], { stdio: 'inherit' });

  const host = await getIp();

  run('sing-box', sbBin, ['run', '-c', CFG_FILE], MEM_SB);

  // 隧道
  let cfHost = '';
  const fixed = Boolean(ARGO_TOKEN);
  if (fixed) {
    run('cloudflared', cfBin, ['tunnel', '--no-autoupdate', 'run', '--token', ARGO_TOKEN], MEM_CF);
    cfHost = ARGO_DOMAIN;
  } else {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      run(
        'cloudflared',
        cfBin,
        ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${ARGO_PORT}`],
        MEM_CF,
        (s) => {
          const m = s.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
          if (m && !done) { cfHost = m[1]; finish(); }
        }
      );
      setTimeout(finish, 45000);
    });
  }

  const links = [];

  if (HY2_PORT) {
    links.push(
      `hysteria2://${state.password}@${host}:${HY2_PORT}` +
      `?sni=bing.com&insecure=1&pinSHA256=${fp}#hy2-${host}`
    );
  }
  if (TUIC_PORT) {
    links.push(
      `tuic://${state.uuid}:${state.password}@${host}:${TUIC_PORT}` +
      `?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=bing.com&insecure=1&pinSHA256=${fp}#tuic-${host}`
    );
  }
  if (ANYTLS_PORT) {
    links.push(
      `anytls://${state.password}@${host}:${ANYTLS_PORT}` +
      `?sni=bing.com&insecure=1&pinSHA256=${fp}#anytls-${host}`
    );
  }
  if (cfHost) {
    links.push(
      `vless://${state.uuid}@${cfHost}:443?encryption=none&security=tls&sni=${cfHost}` +
      `&fp=chrome&type=ws&host=${cfHost}&path=${encodeURIComponent('/' + state.wsPath)}#vless-ws-${cfHost}`
    );
  }

  fs.writeFileSync(LINKS_FILE, links.join('\n') + '\n');

  log('\n=== 部署完成 ===');
  log(`IP        : ${host}`);
  log(`密码      : ${state.password}`);
  log(`UUID      : ${state.uuid}`);
  log(`WS_PATH   : /${state.wsPath}`);
  log(`证书指纹  : ${fp}`);
  log(`HY2       : ${HY2_PORT || '关闭'}`);
  log(`TUIC      : ${TUIC_PORT || '关闭'}`);
  log(`AnyTLS    : ${ANYTLS_PORT || '关闭'}`);
  log(`ARGO      : ${fixed ? `固定隧道 ${ARGO_DOMAIN || '(缺少 ARGO_DOMIAN)'}` : '临时隧道'}`);
  log(`链接文件  : ${LINKS_FILE}\n`);
  log(links.join('\n'));

  if (fixed && !ARGO_DOMAIN) {
    log('\n已启用固定隧道但 ARGO_DOMIAN 为空，请在 Cloudflare 后台绑定的域名填入后重新生成链接。');
  }
})();