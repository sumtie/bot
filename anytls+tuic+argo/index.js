#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), https = require('https'),
      zlib = require('zlib'), crypto = require('crypto'), { spawn } = require('child_process');
const selfsigned = require('selfsigned');

const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'sing-box'), CERT = path.join(DIR, 'cert.pem'), KEY = path.join(DIR, 'key.pem');
const CONF = path.join(DIR, 'config.json'), LINK = path.join(DIR, 'links.txt');

const SB_URL = process.env.SB_URL ||
  'https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-amd64-musl.tar.gz';
const PORT = Number(process.env.SERVER_PORT || 8443);
const SNI = process.env.SNI || 'www.bing.com';
const PASSWORD = process.env.PASSWORD || crypto.randomBytes(12).toString('base64url');
const UUID = crypto.randomUUID();

const ARGO_TOKEN = process.env.ARGO_TOKEN || '';
const ARGO_PORT = Number(process.env.ARGO_PORT || 8080);
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const VLESS_UUID = crypto.randomUUID();
const WS_PATH = '/' + crypto.randomBytes(6).toString('hex');

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

  const inbounds = [
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
  ];
  const links = [
    `tuic://${UUID}:${PASSWORD}@${host}:${PORT}?congestion_control=bbr&alpn=h3&sni=${SNI}&allow_insecure=1#tuic-${host}`,
    `anytls://${PASSWORD}@${host}:${PORT}?security=tls&sni=${SNI}&alpn=h2%2Chttp%2F1.1&allow_insecure=1&insecure=1&type=tcp#anytls-${host}`
  ];

  const route = { rules: [], final: 'direct' };

  if (ARGO_TOKEN) {
    inbounds.push({
      type: 'vless', tag: 'vless-in', listen: '127.0.0.1', listen_port: ARGO_PORT,
      users: [{ uuid: VLESS_UUID, flow: '' }],
      transport: { type: 'ws', path: WS_PATH }
    });
    inbounds.push({
      type: 'cloudflared', tag: 'argo-in', token: ARGO_TOKEN,
      protocol: 'quic', edge_ip_version: 4
    });
    route.rules.push({ inbound: ['argo-in'], outbound: 'direct' });

    const d = ARGO_DOMAIN || '<你的隧道域名>';
    links.push(
      `vless://${VLESS_UUID}@${d}:443?encryption=none&security=tls&sni=${d}&type=ws&host=${d}&path=${encodeURIComponent(WS_PATH)}#vless-argo`
    );
  }

  const cfg = {
    log: { level: 'info', timestamp: true },
    inbounds,
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route
  };
  fs.writeFileSync(CONF, JSON.stringify(cfg, null, 2));
  fs.writeFileSync(LINK, links.join('\n') + '\n');

  console.log(`\n端口: ${PORT}  密码: ${PASSWORD}`);
  if (ARGO_TOKEN) console.log(`Argo: 本地 ${ARGO_PORT}  path ${WS_PATH}  域名 ${ARGO_DOMAIN || '未填写'}`);
  console.log('\n' + links.join('\n'));

  const child = spawn(BIN, ['run', '-c', CONF], { stdio: 'inherit' });
  const bye = () => { try { child.kill('SIGTERM'); } catch {} };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  child.on('exit', c => process.exit(c || 0));
})().catch(e => { console.error(e); process.exit(1); });