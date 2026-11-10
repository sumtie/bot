#!/usr/bin/env node
const fs = require('fs'), path = require('path'), https = require('https'),
      zlib = require('zlib'), crypto = require('crypto'), { spawn } = require('child_process');
const selfsigned = require('selfsigned');

const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'sing-box'), CERT = path.join(DIR, 'cert.pem'), KEY = path.join(DIR, 'key.pem');
const CONF = path.join(DIR, 'config.json'), LINK = path.join(DIR, 'links.txt');

const SB_URL = process.env.SB_URL ||
  'https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-amd64-musl.tar.gz';
const PORT = Number(process.env.SERVER_PORT || 443);
const SNI = process.env.SNI || 'www.bing.com';
const PASSWORD = process.env.PASSWORD || crypto.randomBytes(12).toString('base64url');
const UUID = crypto.randomUUID();

fs.mkdirSync(DIR, { recursive: true });

/* ---------- 下载 ---------- */
const get = (url, d = 0) => new Promise((ok, no) => {
  https.get(url, r => {
    if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && d < 5) {
      r.resume(); return ok(get(new URL(r.headers.location, url).href, d + 1));
    }
    if (r.statusCode !== 200) return no(new Error('HTTP ' + r.statusCode));
    const b = []; r.on('data', c => b.push(c)); r.on('end', () => ok(Buffer.concat(b)));
  }).on('error', no);
});

/* ---------- 极简 tar 解包 ---------- */
function untar(buf, name) {
  let o = 0;
  while (o + 512 <= buf.length) {
    const h = buf.subarray(o, o + 512);
    if (h[0] === 0) break;
    const n = h.subarray(0, 100).toString().replace(/\0.*$/, '');
    const size = parseInt(h.subarray(124, 136).toString().replace(/\0.*$/, '').trim() || '0', 8);
    const s = o + 512;
    if (path.basename(n) === name) return buf.subarray(s, s + size);
    o = s + Math.ceil(size / 512) * 512;
  }
  return null;
}

/* ---------- 自签证书 ---------- */
function makeCert(host) {
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: SNI }, { name: 'organizationName', value: 'sb' }],
    {
      keySize: 2048, days: 3650, algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [
          { type: 2, value: SNI },
          { type: 7, ip: host }
        ] }
      ]
    }
  );
  return { cert: pems.cert, key: pems.private };
}

/* ---------- 主流程 ---------- */
(async () => {
  if (!fs.existsSync(BIN)) {
    console.log('下载 sing-box ...');
    const data = untar(zlib.gunzipSync(await get(SB_URL)), 'sing-box');
    if (!data) throw new Error('压缩包内未找到 sing-box');
    fs.writeFileSync(BIN, data, { mode: 0o755 });
    fs.chmodSync(BIN, 0o755);
  }

  let host = process.env.HOST;
  if (!host) { try { host = (await get('https://api.ipify.org')).toString().trim(); } catch { host = '127.0.0.1'; } }

  if (!fs.existsSync(CERT) || !fs.existsSync(KEY)) {
    const { cert, key } = makeCert(host);
    fs.writeFileSync(CERT, cert);
    fs.writeFileSync(KEY, key, { mode: 0o600 });
  }

  const cfg = {
    log: { level: 'info', timestamp: true },
    inbounds: [
      {
        type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: PORT,
        users: [{ uuid: UUID, password: PASSWORD }],
        congestion_control: 'bbr',
        tls: { enabled: true, server_name: SNI, alpn: ['h3'], certificate_path: CERT, key_path: KEY }
      },
      {
        type: 'anytls', tag: 'anytls-in', listen: '::', listen_port: PORT,
        users: [{ password: PASSWORD }],
        tls: { enabled: true, server_name: SNI, alpn: ['h2', 'http/1.1'], certificate_path: CERT, key_path: KEY }
      }
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }]
  };
  fs.writeFileSync(CONF, JSON.stringify(cfg, null, 2));

  const links = [
    `tuic://${UUID}:${PASSWORD}@${host}:${PORT}?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=${SNI}&allow_insecure=1#tuic-${host}`,
    `anytls://${PASSWORD}@${host}:${PORT}?security=tls&sni=${SNI}&alpn=h2%2Chttp%2F1.1&allow_insecure=1&insecure=1&type=tcp#anytls-${host}`
  ].join('\n') + '\n';
  fs.writeFileSync(LINK, links);

  console.log(`\n端口: ${PORT}  密码: ${PASSWORD}\n${links}`);

  const child = spawn(BIN, ['run', '-c', CONF], { stdio: 'inherit' });
  const bye = () => { try { child.kill('SIGTERM'); } catch {} };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  child.on('exit', c => process.exit(c || 0));
})().catch(e => { console.error(e); process.exit(1); });