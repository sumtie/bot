const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const selfsigned = require('selfsigned');

const VERSION = '1.11.4';
const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'sing-box');
const CFG = path.join(DIR, 'config.json');
const CRT = path.join(DIR, 'cert.crt');
const KEY = path.join(DIR, 'cert.key');
const NODES = path.join(DIR, 'nodes.txt');
const STATE = path.join(DIR, 'state.json');
const SNI = process.env.SNI || 'bing.com';

const toPort = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0;
};
const HY2_PORT = toPort(process.env.HY2_PORT);
const TUIC_PORT = toPort(process.env.TUIC_PORT);

if (!HY2_PORT && !TUIC_PORT) {
  console.error('HY2_PORT / TUIC_PORT 至少填一个');
  process.exit(1);
}
if (HY2_PORT && TUIC_PORT && HY2_PORT === TUIC_PORT) {
  console.error('HY2_PORT 与 TUIC_PORT 不能相同');
  process.exit(1);
}

function download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 8) return reject(new Error('重定向过多'));
    const lib = url.startsWith('https:') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

// 极简 tar.gz 解包：只取出目标文件
function extract(file, dir, want) {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  let off = 0;
  while (off + 512 <= buf.length) {
    const head = buf.subarray(off, off + 512);
    const name = head.subarray(0, 100).toString().replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(head.subarray(124, 136).toString().replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(head[156]);
    if ((type === '0' || type === '\0') && path.basename(name) === want) {
      fs.writeFileSync(path.join(dir, want), buf.subarray(off + 512, off + 512 + size), { mode: 0o755 });
      return true;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return false;
}

function publicIP() {
  return new Promise((resolve, reject) => {
    https.get('https://api.ipify.org', (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d.trim()));
    }).on('error', reject);
  });
}

function fingerprint(pem) {
  const der = new crypto.X509Certificate(pem).raw;
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');
}

function makeCert() {
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: SNI }],
    {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: SNI }] }],
    }
  );
  fs.writeFileSync(CRT, pems.cert, { mode: 0o600 });
  fs.writeFileSync(KEY, pems.private, { mode: 0o600 });
  return fingerprint(pems.cert);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });

  if (!fs.existsSync(BIN)) {
    const arch = { x64: 'amd64', arm64: 'arm64', arm: 'armv7', ia32: '386' }[process.arch];
    if (!arch) throw new Error('不支持的架构: ' + process.arch);
    const os = process.platform === 'darwin' ? 'darwin' : 'linux';
    const asset = `sing-box-${VERSION}-${os}-${arch}.tar.gz`;
    const tmp = path.join(DIR, asset);
    console.log('下载', asset);
    await download(`https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${asset}`, tmp);
    if (!extract(tmp, DIR, 'sing-box')) throw new Error('压缩包内未找到二进制');
    fs.unlinkSync(tmp);
    fs.chmodSync(BIN, 0o755);
  }

  const state = loadState();
  const password = process.env.PASSWORD || state.password || crypto.randomBytes(16).toString('base64url');
  const uuid = process.env.UUID || state.uuid || crypto.randomUUID();
  fs.writeFileSync(STATE, JSON.stringify({ password, uuid }, null, 2), { mode: 0o600 });

  const pin = fs.existsSync(CRT) ? fingerprint(fs.readFileSync(CRT, 'utf8')) : makeCert();
  const host = process.env.HOST || (await publicIP());

  const tls = { enabled: true, alpn: ['h3'], certificate_path: CRT, key_path: KEY };
  const inbounds = [];
  if (HY2_PORT) {
    inbounds.push({
      type: 'hysteria2', tag: 'hy2-in', listen: '::', listen_port: HY2_PORT,
      users: [{ password }], tls,
    });
  }
  if (TUIC_PORT) {
    inbounds.push({
      type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: TUIC_PORT,
      users: [{ uuid, password }], congestion_control: 'bbr', tls,
    });
  }

  fs.writeFileSync(CFG, JSON.stringify({
    log: { level: 'info', timestamp: true },
    inbounds,
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct' },
  }, null, 2));

  const links = [];
  if (HY2_PORT) {
    links.push(`hysteria2://${encodeURIComponent(password)}@${host}:${HY2_PORT}/?sni=${SNI}&insecure=1&pinSHA256=${pin}#hy2-${host}`);
  }
  if (TUIC_PORT) {
    links.push(`tuic://${uuid}:${encodeURIComponent(password)}@${host}:${TUIC_PORT}?sni=${SNI}&alpn=h3&congestion_control=bbr&udp_relay_mode=native&allow_insecure=1&pinSHA256=${pin}#tuic-${host}`);
  }
  fs.writeFileSync(NODES, links.join('\n') + '\n');

  console.log('密码:', password);
  console.log('证书 SHA-256:', pin);
  console.log(links.join('\n'));
  console.log('状态文件:', STATE);
  console.log('节点文件:', NODES);
  console.log('配置:', CFG);

  const child = spawn(BIN, ['run', '-c', CFG], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code || 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});