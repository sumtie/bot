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
const OUT_FILE = path.join(DIR, 's.txt');//节点信息
const VER = '1.11.4';
const SNI = process.env.SNI || 'www.bing.com';
const WEB = Number(process.env.PORT || 0);

// 把3000替换为你服务器的端口号
const PORT = Number(process.env.HY_PORT || 3000);

// ---------- 密码：填了就用，没填就生成并落盘复用 ----------
let pass = (process.env.PASSWORD || '').trim();
if (!pass) {
  pass = fs.existsSync(PASS_FILE) ? fs.readFileSync(PASS_FILE, 'utf8').trim() : '';
  if (!pass) pass = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(PASS_FILE, pass);
}

// ---------- 指纹格式：61:BC:FD:70:... ----------
const colonHex = h => (h.toUpperCase().match(/../g) || []).join(':');

// ---------- 最小 DER 编码器（无 openssl 时自签用） ----------
const D = {
  len(n) {
    if (n < 0x80) return Buffer.from([n]);
    const b = [];
    while (n > 0) { b.unshift(n & 0xff); n >>>= 8; }
    return Buffer.from([0x80 | b.length, ...b]);
  },
  tlv(tag, val) { return Buffer.concat([Buffer.from([tag]), D.len(val.length), val]); },
  seq(...v) { return D.tlv(0x30, Buffer.concat(v)); },
  set(...v) { return D.tlv(0x31, Buffer.concat(v)); },
  oid(s) {
    const p = s.split('.').map(Number);
    const out = [40 * p[0] + p[1]];
    for (const n of p.slice(2)) {
      const chunk = [];
      let v = n;
      do { chunk.unshift(v & 0x7f); v >>>= 7; } while (v > 0);
      for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
      out.push(...chunk);
    }
    return D.tlv(0x06, Buffer.from(out));
  },
  utf8(s) { return D.tlv(0x0c, Buffer.from(s, 'utf8')); },
  utc(d) {
    const p = n => String(n).padStart(2, '0');
    const s = p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
      p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
    return D.tlv(0x17, Buffer.from(s, 'ascii'));
  },
  pem(der, label) {
    const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
  }
};

// ---------- 纯 Node 自签证书（ECDSA P-256, 10 年） ----------
function makeCertNode() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const name = D.seq(D.set(D.seq(D.oid('2.5.4.3'), D.utf8(SNI))));
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;

  const now = new Date();
  const exp = new Date(now.getTime() + 3650 * 864e5);
  const sigAlg = D.seq(D.oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256

  const tbs = D.seq(
    D.tlv(0xa0, D.tlv(0x02, Buffer.from([2]))), // version v3
    D.tlv(0x02, serial),
    sigAlg,
    name,
    name,
    D.seq(D.utc(now), D.utc(exp)),
    spki,
    D.tlv(0xa3, D.seq( // extensions
      D.seq(D.oid('2.5.29.19'), D.tlv(0x01, Buffer.from([0xff])),
        D.tlv(0x04, D.seq(D.tlv(0x01, Buffer.from([0xff]))))), // basicConstraints CA:TRUE
      D.seq(D.oid('2.5.29.15'), D.tlv(0x01, Buffer.from([0xff])),
        D.tlv(0x04, D.tlv(0x03, Buffer.from([0x07, 0x80])))), // keyUsage digitalSignature
      D.seq(D.oid('2.5.29.17'), // subjectAltName
        D.tlv(0x04, D.seq(D.tlv(0x82, Buffer.from(SNI, 'ascii')))))
    ))
  );

  const sig = crypto.sign('sha256', tbs, privateKey);
  const der = D.seq(tbs, sigAlg, D.tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));

  fs.writeFileSync(CERT, D.pem(der, 'CERTIFICATE'), { mode: 0o644 });
  fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
}

// ---------- 自签证书（10 年，复用）：优先 openssl，缺失则用 Node ----------
function makeCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return;
  let hasOpenssl = false;
  try { execSync('openssl version', { stdio: 'ignore' }); hasOpenssl = true; } catch { }
  if (hasOpenssl) {
    try {
      execSync(
        `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes ` +
        `-keyout "${KEY}" -out "${CERT}" -days 3650 -subj "/CN=${SNI}" ` +
        `-addext "subjectAltName=DNS:${SNI}"`, { stdio: 'ignore' }
      );
      if (fs.existsSync(CERT) && fs.existsSync(KEY)) return;
    } catch { }
  }
  makeCertNode();
}

function loadCert() {
  try {
    return new crypto.X509Certificate(fs.readFileSync(CERT));
  } catch {
    fs.rmSync(CERT, { force: true });
    fs.rmSync(KEY, { force: true });
    makeCertNode();
    return new crypto.X509Certificate(fs.readFileSync(CERT));
  }
}

// ---------- 下载 sing-box ----------
function ensureBin() {
  if (fs.existsSync(BIN)) return;
  console.log('[*]拉取二进制文件中...');
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

  const cert = loadCert();
  // 证书 DER 的 SHA-256：pinSHA256 与展示指纹都用它
  const pinHex = crypto.createHash('sha256').update(cert.raw).digest('hex');
  const pinPretty = colonHex(pinHex);

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
    `hysteria2://${encodeURIComponent(pass)}@${h}:${PORT}/?sni=${SNI}&alpn=h3&insecure=1&pinSHA256=${pinPretty}#HY2-${h.includes(':') ? 'IPv6' : 'IPv4'}`
  );

  const out = [
    '===== 节点信息 =====',
    `端口: ${PORT}  SNI: ${SNI}`,
    `密码: ${pass}`,
    `证书指纹SHA256: ${pinPretty}`,
    ...(links.length ? links : ['未取到公网 IP，请手动拼接域名/IP']),
    '=========================='
  ].join('\n');
  console.log(out);
  fs.writeFileSync(OUT_FILE, out + '\n', { mode: 0o600 });
  console.log(`已写入 ${OUT_FILE}`);

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