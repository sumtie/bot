#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const VERSION = '1.14.4';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '.npm');
const BIN = path.join(DIR, 'sing-box');
const CFG = path.join(DIR, 'config.json');
const STATE = path.join(DIR, 'state.json');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const LINKS = path.join(DIR, 'links.txt');
const TARBALL = path.join(DIR, 'pkg.tar.gz');

const env = process.env;
const SHOW_LOG = String(env.SHOW_LOG ?? 'true') !== 'false';
const ARGO_TOKEN = env.ARGO_TOKEN || '';
const ARGO_PORT = Number(env.ARGO_PORT || 8080);
const ARGO_DOMAIN = env.ARGO_DOMAIN || '';
const HY2_PORT = Number(env.HY2_PORT || 0);
const TUIC_PORT = Number(env.TUIC_PORT || 0);
const ANYTLS_PORT = Number(env.ANYTLS_PORT || 0);

const ARCH = { x64: 'amd64', arm64: 'arm64' }[process.arch];
const SNI = ARGO_DOMAIN || 'localhost';

/* ---------------- 自签证书 ---------------- */
const der = (certPem) => Buffer.from(certPem.split('\n').filter((l) => !l.includes('-----')).join(''), 'base64');
const fingerprint = (certPem) =>
  crypto.createHash('sha256').update(der(certPem)).digest('hex').toUpperCase().match(/../g).join(':');

function makeCert() {
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];
  if (ARGO_DOMAIN) altNames.push({ type: 2, value: ARGO_DOMAIN });
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: ARGO_DOMAIN || 'sing-box' }],
    {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'subjectAltName', altNames },
      ],
    },
  );
  fs.writeFileSync(CERT, pems.cert);
  fs.writeFileSync(KEY, pems.private, { mode: 0o600 });
  return fingerprint(pems.cert);
}

/* ---------------- 下载 / 解包 ---------------- */
async function download() {
  const pkg = `sing-box-${VERSION}-linux-${ARCH}-musl`;
  const url = `https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${pkg}.tar.gz`;
  console.log(`[+] 下载 ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(TARBALL));
  const r = spawnSync('tar', ['-xzf', TARBALL, '-C', DIR], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('解压失败');
  fs.renameSync(path.join(DIR, pkg, 'sing-box'), BIN);
  fs.chmodSync(BIN, 0o755);
  fs.rmSync(path.join(DIR, pkg), { recursive: true, force: true });
  fs.rmSync(TARBALL, { force: true });
}

/* ---------------- 状态 ---------------- */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
const state = loadState();
const password = env.PASSWORD || state.password || crypto.randomBytes(9).toString('base64url');
const uuid = env.UUID || state.uuid || crypto.randomUUID();
const wsPath = state.wsPath || '/' + crypto.randomBytes(8).toString('hex');
fs.writeFileSync(STATE, JSON.stringify({ password, uuid, wsPath }, null, 2), { mode: 0o600 });

/* ---------------- 主机地址 ---------------- */
function localHost() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}
async function publicHost() {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(4000) });
    const ip = (await res.text()).trim();
    if (ip) return ip;
  } catch {}
  return localHost();
}

/* ---------------- 配置 ---------------- */
function build(fp, host) {
  const tls = () => ({ enabled: true, server_name: SNI, alpn: ['h3'], certificate_path: CERT, key_path: KEY });
  const inbounds = [];
  const rules = [];

  if (HY2_PORT) inbounds.push({
    type: 'hysteria2', tag: 'hy2-in', listen: '::', listen_port: HY2_PORT,
    users: [{ name: 'user', password }], tls: tls(),
  });
  if (TUIC_PORT) inbounds.push({
    type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: TUIC_PORT,
    users: [{ name: 'user', uuid, password }], congestion_control: 'bbr', tls: tls(),
  });
  if (ANYTLS_PORT) inbounds.push({
    type: 'anytls', tag: 'anytls-in', listen: '::', listen_port: ANYTLS_PORT,
    users: [{ name: 'user', password }], tls: tls(),
  });
  if (ARGO_TOKEN) {
    inbounds.push({
      type: 'vless', tag: 'vless-in', listen: '127.0.0.1', listen_port: ARGO_PORT,
      users: [{ name: 'user', uuid }],
      transport: { type: 'ws', path: wsPath },
    });
    inbounds.push({ type: 'cloudflared', tag: 'cf-in', token: ARGO_TOKEN });
    rules.push({
      inbound: ['cf-in'], action: 'route', outbound: 'direct',
      override_address: '127.0.0.1', override_port: ARGO_PORT,
    });
  }

  const cfg = {
    log: { disabled: !SHOW_LOG, level: 'info', timestamp: true },
    dns: { servers: [{ type: 'local', tag: 'local' }] },
    inbounds,
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { rules, final: 'direct', default_domain_resolver: 'local' },
  };
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2), { mode: 0o600 });

  const n = (s) => encodeURIComponent(`${s}-${host}`);
  const links = [];
  if (HY2_PORT) links.push(`hysteria2://${encodeURIComponent(password)}@${host}:${HY2_PORT}?sni=${SNI}&insecure=1&pinSHA256=${fp}#${n('HY2')}`);
  if (TUIC_PORT) links.push(`tuic://${uuid}:${encodeURIComponent(password)}@${host}:${TUIC_PORT}?sni=${SNI}&alpn=h3&congestion_control=bbr&udp_relay_mode=native&allow_insecure=1#${n('TUIC')}`);
  if (ANYTLS_PORT) links.push(`anytls://${encodeURIComponent(password)}@${host}:${ANYTLS_PORT}?sni=${SNI}&insecure=1#${n('AnyTLS')}`);
  if (ARGO_TOKEN && ARGO_DOMAIN) links.push(`vless://${uuid}@${ARGO_DOMAIN}:443?encryption=none&security=tls&sni=${ARGO_DOMAIN}&fp=chrome&type=ws&host=${ARGO_DOMAIN}&path=${encodeURIComponent(wsPath)}#${n('VLESS-WS')}`);
  fs.writeFileSync(LINKS, links.join('\n') + '\n', { mode: 0o600 });
  return links;
}

/* ---------------- 主流程 ---------------- */
async function main() {
  if (process.platform !== 'linux') throw new Error('仅支持 Linux');
  if (!ARCH) throw new Error(`不支持的架构 ${process.arch}`);
  if (HY2_PORT && TUIC_PORT && HY2_PORT === TUIC_PORT) throw new Error('HY2_PORT 与 TUIC_PORT 不能相同（同为 UDP）');
  for (const [k, p] of Object.entries({ HY2_PORT, TUIC_PORT, ANYTLS_PORT, ARGO_PORT }))
    if (p && (p < 1 || p > 65535)) throw new Error(`${k} 端口非法`);

  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

  if (!fs.existsSync(BIN)) await download();
  else console.log('[+] 复用已有二进制');

  const fp = fs.existsSync(CERT) && fs.existsSync(KEY) ? fingerprint(fs.readFileSync(CERT, 'utf8')) : makeCert();
  console.log(`[+] 证书 SHA-256: ${fp}`);

  const links = build(fp, await publicHost());
  const chk = spawnSync(BIN, ['check', '-c', CFG], { encoding: 'utf8' });
  if (chk.status !== 0) throw new Error(`配置校验失败\n${chk.stdout}${chk.stderr}`);

  console.log(`[+] 已启用: ${[HY2_PORT && 'hysteria2', TUIC_PORT && 'tuic', ANYTLS_PORT && 'anytls', ARGO_TOKEN && 'vless+ws/argo'].filter(Boolean).join(', ')}`);
  for (const l of links) console.log(l);
  console.log(`[+] 链接已写入 ${LINKS}`);

  const child = spawn(BIN, ['run', '-c', CFG], {
    stdio: ['ignore', SHOW_LOG ? 'inherit' : 'ignore', 'inherit'],
    env: { ...env, GOMEMLIMIT: env.GOMEMLIMIT || '96MiB', GOGC: env.GOGC || '25' },
  });
  const bye = () => child.kill('SIGTERM');
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((e) => { console.error('[!]', e.message); process.exit(1); });