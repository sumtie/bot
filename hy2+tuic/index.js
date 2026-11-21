#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const V = '1.11.4';
const SNI = 'www.bing.com';
const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'sing-box');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const CFG = path.join(DIR, 'config.json');
const STATE = path.join(DIR, 'state.json');
const LINKS = path.join(DIR, 'links.txt');

const hy2Port = Number(process.env.HY2_PORT) || 0;
const tuicPort = Number(process.env.TUIC_PORT) || 0;
const showLog = /^(1|true|yes|on)$/i.test(process.env.SHOW_LOG || '');

const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;

// 流式下载：响应流直接 pipe 到文件，全程不落内存
function get(url, dest) {
  return new Promise((ok, no) => {
    https.get(url, { headers: { 'user-agent': 'node' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return ok(get(r.headers.location, dest));
      }
      if (r.statusCode !== 200) {
        r.resume();
        return no(new Error('HTTP ' + r.statusCode));
      }
      const w = fs.createWriteStream(dest);
      r.pipe(w);
      w.on('finish', () => w.close(ok));
      w.on('error', no);
      r.on('error', no);
    }).on('error', no);
  });
}

async function ensureBin() {
  if (fs.existsSync(BIN)) return;
  const name = `sing-box-${V}-linux-${arch}`;
  const tgz = path.join(DIR, name + '.tar.gz');
  await get(`https://github.com/SagerNet/sing-box/releases/download/v${V}/${name}.tar.gz`, tgz);
  execFileSync('tar', ['-xzf', tgz, '-C', DIR]);
  fs.renameSync(path.join(DIR, name, 'sing-box'), BIN);
  fs.chmodSync(BIN, 0o755);
  fs.rmSync(path.join(DIR, name), { recursive: true, force: true });
  fs.rmSync(tgz);
}

function ensureCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return;
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', KEY, '-out', CERT, '-days', '3650', '-nodes',
    '-subj', `/CN=${SNI}`, '-addext', `subjectAltName=DNS:${SNI}`
  ], { stdio: 'ignore' });
}

function fingerprint() {
  const out = execFileSync('openssl', ['x509', '-in', CERT, '-noout', '-fingerprint', '-sha256']).toString();
  return out.split('=')[1].trim();
}

function loadState() {
  if (fs.existsSync(STATE)) return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const s = { password: crypto.randomBytes(16).toString('base64url'), uuid: crypto.randomUUID() };
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  return s;
}

const getIP = () => new Promise((ok, no) => {
  https.get('https://api.ipify.org', r => {
    let d = '';
    r.on('data', c => (d += c));
    r.on('end', () => ok(d.trim()));
  }).on('error', no);
});

async function main() {
  if (!arch) throw new Error('unsupported arch: ' + process.arch);
  if (!hy2Port && !tuicPort) throw new Error('set HY2_PORT and/or TUIC_PORT');
  if (hy2Port && tuicPort && hy2Port === tuicPort) throw new Error('HY2_PORT and TUIC_PORT must differ');

  fs.mkdirSync(DIR, { recursive: true });
  await ensureBin();
  ensureCert();

  const { password, uuid } = loadState();
  const host = process.env.HOST || (await getIP());
  const sha = fingerprint();
  const tls = { enabled: true, server_name: SNI, alpn: ['h3'], certificate_path: CERT, key_path: KEY };

  const inbounds = [];
  const links = [];

  if (hy2Port) {
    inbounds.push({ type: 'hysteria2', tag: 'hy2', listen: '::', listen_port: hy2Port, users: [{ password }], tls });
    links.push(`hysteria2://${encodeURIComponent(password)}@${host}:${hy2Port}/?sni=${SNI}&insecure=1&pinSHA256=${sha}#hy2`);
  }
  if (tuicPort) {
    inbounds.push({ type: 'tuic', tag: 'tuic', listen: '::', listen_port: tuicPort, users: { [uuid]: password }, congestion_control: 'bbr', tls });
    links.push(`tuic://${uuid}:${encodeURIComponent(password)}@${host}:${tuicPort}?sni=${SNI}&alpn=h3&congestion_control=bbr&udp_relay_mode=native&insecure=1&pinSHA256=${sha}#tuic`);
  }

  fs.writeFileSync(CFG, JSON.stringify({
    log: { disabled: !showLog, level: 'info', timestamp: true },
    inbounds,
    outbounds: [{ type: 'direct', tag: 'direct' }]
  }, null, 2));
  fs.writeFileSync(LINKS, links.join('\n') + '\n');
  console.log(links.join('\n'));

  spawn(BIN, ['run', '-c', CFG], { stdio: showLog ? 'inherit' : 'ignore' })
    .on('exit', c => process.exit(c));
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});