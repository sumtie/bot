'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { Readable } = require('stream');

const VERSION = 'v1.4.5';
const ARCH = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
if (process.platform !== 'linux' || !ARCH) {
  console.error('仅支持 linux amd64 / arm64');
  process.exit(1);
}

const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'tuic-server');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const CONF = path.join(DIR, 'config.toml');
const STATE = path.join(DIR, 'state.json');
const NODE = path.join(DIR, 'node.txt');
const LOG = path.join(DIR, 'tuic.log');

const PORT = Number(process.env.PORT) || 8443;
const SNI = 'www.bing.com';
const SHOW_LOG = String(process.env.SHOW_LOG).toLowerCase() === 'true';

fs.mkdirSync(DIR, { recursive: true });

async function download() {
  if (fs.existsSync(BIN) && fs.statSync(BIN).size > 1024) return;
  const url = `https://github.com/Itsusinn/tuic/releases/download/${VERSION}/tuic-server-${ARCH}-linux`;
  console.log('下载 ' + url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('下载失败: ' + res.status);
  const tmp = BIN + '.part';
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    Readable.fromWeb(res.body).pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
  fs.renameSync(tmp, BIN);
  fs.chmodSync(BIN, 0o755);
}

function loadState() {
  let s = {};
  if (fs.existsSync(STATE)) {
    try { s = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { s = {}; }
  }
  if (!s.password) s.password = crypto.randomBytes(18).toString('base64url');
  if (!s.uuid) s.uuid = crypto.randomUUID();
  if (!s.secret) s.secret = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
}

// rustls 只接受 PKCS#8 私钥
function ensureCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) {
    if (fs.readFileSync(KEY, 'utf8').includes('BEGIN PRIVATE KEY')) return;
    fs.rmSync(CERT, { force: true });
    fs.rmSync(KEY, { force: true });
  }
  execFileSync('openssl', [
    'genpkey', '-algorithm', 'EC',
    '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-out', KEY,
  ], { stdio: 'ignore' });
  execFileSync('openssl', [
    'req', '-x509', '-key', KEY, '-out', CERT,
    '-days', '3650', '-subj', '/CN=' + SNI,
  ], { stdio: 'ignore' });
  fs.chmodSync(KEY, 0o600);
}

function sha256() {
  const out = execFileSync('openssl', ['x509', '-in', CERT, '-noout', '-fingerprint', '-sha256']).toString();
  return out.split('=')[1].trim().toUpperCase();
}

async function publicHost() {
  if (process.env.HOST) return process.env.HOST;
  try {
    const r = await fetch('https://api.ipify.org');
    return (await r.text()).trim();
  } catch {
    return '127.0.0.1';
  }
}

function writeConfig(uuid, password, secret) {
  fs.writeFileSync(CONF, `log_level = "info"
server = "0.0.0.0:${PORT}"
udp_relay_ipv6 = true
zero_rtt_handshake = false
dual_stack = false
auth_timeout = "3s"
max_external_packet_size = 1500

[users]
${uuid} = "${password}"

[tls]
self_sign = false
certificate = "${CERT}"
private_key = "${KEY}"
alpn = ["h3"]

[restful]
addr = "127.0.0.1:${PORT + 1}"
secret = "${secret}"
maximum_clients_per_user = 0

[quic]
gso = true
pmtu = true
max_idle_time = "10s"

[quic.congestion_control]
controller = "bbr"
`, { mode: 0o600 });
}

function tail(file, n = 30) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    console.error('--- tuic 最后 ' + n + ' 行日志 ---');
    console.error(lines.slice(-n).join('\n'));
  } catch {}
}

let child = null;
let stopping = false;

function start() {
  if (SHOW_LOG) {
    child = spawn(BIN, ['-c', CONF], { cwd: DIR, stdio: 'inherit' });
  } else {
    const fd = fs.openSync(LOG, 'w');
    child = spawn(BIN, ['-c', CONF], { cwd: DIR, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
  }
  child.on('exit', (code, sig) => {
    child = null;
    if (stopping) return;
    console.log(`tuic 退出 (${code ?? sig})，3 秒后重启`);
    if (code !== 0) tail(LOG);
    setTimeout(start, 3000);
  });
}

function shutdown() {
  stopping = true;
  if (child) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}

(async () => {
  await download();
  const { uuid, password, secret } = loadState();
  ensureCert();
  const fp = sha256();
  writeConfig(uuid, password, secret);

  const host = await publicHost();
  const link = `tuic://${uuid}:${encodeURIComponent(password)}@${host}:${PORT}?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=${SNI}&allow_insecure=1&sha256=${fp}#tuic-${host}`;
  fs.writeFileSync(NODE, link + '\n');

  console.log('节点链接:\n' + link);
  console.log('================================');
  console.log('SHA-256: ' + fp);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  start();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});