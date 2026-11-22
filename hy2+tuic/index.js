#!/usr/bin/env node
'use strict';
// sing-box 1.11.4 / hysteria2 + tuic auto-deploy (linux amd64|arm64)
const fs = require('fs'), path = require('path'), https = require('https'), os = require('os'), crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');

const VER = '1.11.4';
const ARCH = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!ARCH) die('unsupported arch: ' + process.arch);
const SHOW_LOG = /^(1|true|yes|on)$/i.test(process.env.SHOW_LOG || '');

const DIR = path.join(__dirname, '.npm');
fs.mkdirSync(DIR, { recursive: true });
const BIN = path.join(DIR, 'sing-box'), CERT = path.join(DIR, 'cert.pem'), KEY = path.join(DIR, 'key.pem');
const STATE = path.join(DIR, 'state.json'), CONFIG = path.join(DIR, 'config.json'), LINKS = path.join(DIR, 'links.txt');
const SNI = 'www.bing.com';

const HY2_PORT = +(process.env.HY2_PORT || 0), TUIC_PORT = +(process.env.TUIC_PORT || 0);
if (!HY2_PORT && !TUIC_PORT) die('set HY2_PORT and/or TUIC_PORT');
if (HY2_PORT && HY2_PORT === TUIC_PORT) die('HY2_PORT and TUIC_PORT must differ');
for (const p of [HY2_PORT, TUIC_PORT]) if (p && (p < 1 || p > 65535)) die('invalid port ' + p);
for (const b of ['openssl', 'tar']) { try { execFileSync('which', [b], { stdio: 'ignore' }); } catch { die('missing ' + b); } }

function die(m) { console.error(m); process.exit(1); }
const log = (...a) => console.log(...a);

async function download(url, dest, depth = 0) {
  if (depth > 5) throw new Error('too many redirects');
  await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'node' } }, res => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        return download(new URL(headers.location, url), dest, depth + 1).then(resolve, reject);
      }
      if (statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + statusCode)); }
      pipeline(res, fs.createWriteStream(dest)).then(resolve, reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

async function ensureBinary() {
  if (fs.existsSync(BIN)) return;
  const name = `sing-box-${VER}-linux-${ARCH}`;
  const tgz = path.join(DIR, name + '.tar.gz');
  log('[sb] downloading ' + VER + ' ' + ARCH);
  await download(`https://github.com/SagerNet/sing-box/releases/download/v${VER}/${name}.tar.gz`, tgz);
  execFileSync('tar', ['-xzf', tgz, '-C', DIR], { stdio: 'ignore' });
  fs.renameSync(path.join(DIR, name, 'sing-box'), BIN);
  fs.rmSync(path.join(DIR, name), { recursive: true, force: true });
  fs.rmSync(tgz, { force: true });
  fs.chmodSync(BIN, 0o755);
}

function ensureCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return;
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-days', '3650', '-subj', '/CN=' + SNI, '-keyout', KEY, '-out', CERT], { stdio: 'ignore' });
}

function fingerprint() {
  const out = execFileSync('openssl', ['x509', '-in', CERT, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' });
  return out.trim().split('=').pop();
}

function loadState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  const password = s.password || process.env.PASSWORD || crypto.randomBytes(12).toString('base64url');
  const uuid = s.uuid || crypto.randomUUID();
  fs.writeFileSync(STATE, JSON.stringify({ password, uuid }, null, 2));
  return { password, uuid };
}

function publicIP() {
  const fallback = () => {
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || [])
      if (a.family === 'IPv4' && !a.internal) return a.address;
    return '127.0.0.1';
  };
  return new Promise(res => {
    const req = https.get('https://api.ipify.org', { headers: { 'user-agent': 'node' } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(d.trim() || fallback()));
    });
    req.on('error', () => res(fallback()));
    req.setTimeout(5000, () => { req.destroy(); res(fallback()); });
  });
}

async function runArgo() {
  if (!process.env.ARGO_AUTH) return;
  const bin = path.join(DIR, 'cloudflared');
  if (!fs.existsSync(bin)) {
    log('[argo] downloading');
    await download(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`, bin);
    fs.chmodSync(bin, 0o755);
  }
  spawn(bin, ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', process.env.ARGO_AUTH],
    { stdio: SHOW_LOG ? 'inherit' : 'ignore', cwd: DIR }).on('exit', c => log('[argo] exited ' + c));
}

(async () => {
  await ensureBinary();
  ensureCert();
  const { password, uuid } = loadState();
  const fp = fingerprint();
  const host = await publicIP();

  const inbounds = [];
  if (HY2_PORT) inbounds.push({
    type: 'hysteria2', tag: 'hy2-in', listen: '::', listen_port: HY2_PORT,
    users: [{ password }],
    tls: { enabled: true, server_name: SNI, alpn: ['h3'], certificate_path: CERT, key_path: KEY }
  });
  if (TUIC_PORT) inbounds.push({
    type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: TUIC_PORT,
    users: [{ uuid, password }], congestion_control: 'bbr',
    tls: { enabled: true, server_name: SNI, alpn: ['h3'], certificate_path: CERT, key_path: KEY }
  });

  fs.writeFileSync(CONFIG, JSON.stringify({
    log: { level: SHOW_LOG ? 'info' : 'warn', timestamp: true },
    inbounds, outbounds: [{ type: 'direct', tag: 'direct' }]
  }, null, 2));
  execFileSync(BIN, ['check', '-c', CONFIG], { stdio: 'ignore' });

  const links = [];
  const enc = encodeURIComponent(password);
  if (HY2_PORT) links.push(`hysteria2://${enc}@${host}:${HY2_PORT}/?sni=${SNI}&insecure=1&pinSHA256=${fp}#hy2-${host}`);
  if (TUIC_PORT) links.push(`tuic://${uuid}:${enc}@${host}:${TUIC_PORT}/?sni=${SNI}&alpn=h3&congestion_control=bbr&allow_insecure=1&pinSHA256=${fp}#tuic-${host}`);
  fs.writeFileSync(LINKS, links.join('\n') + '\n');

  log('password: ' + password);
  log('uuid: ' + uuid);
  log('sha256: ' + fp);
  for (const l of links) log(l);
  log('links -> ' + LINKS);

  await runArgo();

  const child = spawn(BIN, ['run', '-c', CONFIG], { stdio: SHOW_LOG ? 'inherit' : 'ignore', cwd: DIR });
  const stop = () => { try { child.kill('SIGTERM'); } catch {} process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  child.on('exit', c => { log('[sb] exited ' + c); process.exit(c || 0); });
})().catch(e => die(e.message));
