const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const DIR = path.join(__dirname, '.npm');
fs.mkdirSync(DIR, { recursive: true });

const BIN = path.join(DIR, 'sing-box');
const CONF = path.join(DIR, 'config.json');
const PASS_FILE = path.join(DIR, 'password.txt');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const VER = '1.11.4';
const SNI = process.env.SNI || 'www.bing.com';
const WEB = Number(process.env.PORT || 0);

const PORT = Number(process.env.HY_PORT || 3065);

// ---------- 密码：填了就用，没填就生成并落盘复用 ----------
let pass = (process.env.PASSWORD || '').trim();
if (!pass) {
  pass = fs.existsSync(PASS_FILE) ? fs.readFileSync(PASS_FILE, 'utf8').trim() : '';
  if (!pass) pass = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(PASS_FILE, pass);
}

// ---------- 自签证书（10 年，复用） ----------
function makeCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return;
  execSync(
    `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes ` +
    `-keyout "${KEY}" -out "${CERT}" -days 3650 -subj "/CN=${SNI}" ` +
    `-addext "subjectAltName=DNS:${SNI}"`, { stdio: 'ignore' }
  );
}

// ---------- 下载 sing-box ----------
function ensureBin() {
  if (fs.existsSync(BIN)) return;
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const url = `https://github.com/SagerNet/sing-box/releases/download/v${VER}/sing-box-${VER}-linux-${arch}.tar.gz`;
  execSync(`curl -fsSL "${url}" | tar -xz -C "${DIR}" -f - --strip-components=1 --wildcards '*/sing-box'`, { stdio: 'ignore' });
  fs.chmodSync(BIN, 0o755);
}

// ---------- 取公网 IP ----------
const getIp = url => new Promise(res => {
  const r = https.get(url, { timeout: 8000 }, s => {
    let d = '';
    s.on('data', c => d += c);
    s.on('end', () => res(d.trim() || null));
  });
  r.on('error', () => res(null));
  r.on('timeout', () => { r.destroy(); res(null); });
});

(async () => {
  ensureBin();
  makeCert();

  const cert = new crypto.X509Certificate(fs.readFileSync(CERT));
  // v2rayN / sing-box 用：证书公钥(SPKI) SHA-256 的十六进制
  const pin = crypto.createHash('sha256')
    .update(cert.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  // 官方 hysteria 客户端用：整张证书 DER 的 SHA-256 的 base64
  const pinB64 = crypto.createHash('sha256').update(cert.raw).digest('base64');

  const [v6, v4] = await Promise.all([
    getIp('https://v6.ident.me'),
    getIp('https://v4.ident.me'),
  ]);
  const hosts = [...(v6 ? [`[${v6}]`] : []), ...(v4 ? [v4] : [])];

  const cfg = {
    log: { level: 'warn', timestamp: true },
    inbounds: [{
      type: 'hysteria2',
      tag: 'hy2',
      listen: '::',
      listen_port: PORT,
      users: [{ password: pass }],
      tls: {
        enabled: true,
        server_name: SNI,
        alpn: ['h3'],
        certificate_path: CERT,
        key_path: KEY
      }
    }],
    outbounds: [{ type: 'direct', tag: 'direct' }]
  };
  fs.writeFileSync(CONF, JSON.stringify(cfg, null, 2));

  const links = hosts.map(h =>
    `hysteria2://${encodeURIComponent(pass)}@${h}:${PORT}/?sni=${SNI}&alpn=h3&insecure=1&pinSHA256=${pin}#HY2-${h.includes(':') ? 'IPv6' : 'IPv4'}`
  );

  const out = [
    '===== Hysteria2 节点 =====',
    `端口: ${PORT}  SNI: ${SNI}`,
    `密码: ${pass}`,
    `证书公钥SHA256(hex, v2rayN/sing-box): ${pin}`,
    `证书SHA256(base64, 官方hysteria): ${pinB64}`,
    ...(links.length ? links : ['未取到公网 IP，请手动拼接域名/IP']),
    '=========================='
  ].join('\n');
  console.log(out);

  if (WEB) {
    http.createServer((_, s) => s.end(out + '\n')).listen(WEB);
  }

  const run = () => {
    const p = spawn(BIN, ['run', '-c', CONF], { stdio: 'inherit' });
    p.on('error', e => { console.error(e); setTimeout(run, 3000); });
    p.on('exit', c => { console.log('sing-box 退出', c); setTimeout(run, 3000); });
  };
  run();
})().catch(e => { console.error(e); process.exit(1); });
