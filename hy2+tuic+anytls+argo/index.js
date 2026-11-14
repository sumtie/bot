#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

/* ---------------- 常量 ---------------- */
const VERSION = '1.14.4';
const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'sing-box');
const STATE = path.join(DIR, 'state.json');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const CONF = path.join(DIR, 'config.json');
const LINKS = path.join(DIR, 'links.txt');

/* ---------------- 自动获取公网 IP ---------------- */
function getPublicIP() {
  const services = [
    'https://api.ipify.org',
    'https://ipv4.icanhazip.com',
    'https://checkip.amazonaws.com'
  ];

  for (const url of services) {
    try {
      const ip = execFileSync('curl', [
        '-4', '-fsSL', '--max-time', '5', url
      ], { encoding: 'utf8' }).trim();

      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        return ip;
      }
    } catch {}
  }

  return '127.0.0.1';
}

/* ---------------- 环境变量 ---------------- */
const HY2_PORT = Number(process.env.HY2_PORT) || 0;
const TUIC_PORT = Number(process.env.TUIC_PORT) || 0;
const ANYTLS_PORT = Number(process.env.ANYTLS_PORT) || 0;
const ARGO_PORT = Number(process.env.ARGO_PORT) || 8080;
const ARGO_TOKEN = (process.env.ARGO_TOKEN || '').trim();
const ARGO_DOMAIN = (process.env.ARGO_DOMAIN || '').trim() || '<your-tunnel-domain>';
const SNI = (process.env.SNI || '').trim() || 'bing.com';
const HOST = (process.env.PUBLIC_HOST || '').trim() || getPublicIP();

const die = (m) => { console.error('[!] ' + m); process.exit(1); };
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opt });

/* ---------------- 校验 ---------------- */
if (process.platform !== 'linux') die('只支持 Linux');
const ARCH = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!ARCH) die('只支持 amd64 / arm64，当前: ' + process.arch);

if (HY2_PORT && TUIC_PORT && HY2_PORT === TUIC_PORT) die('HY2_PORT 与 TUIC_PORT 不能相同');
// for (const [a, b] of [[HY2_PORT, ANYTLS_PORT], [TUIC_PORT, ANYTLS_PORT]])
//   if (a && b && a === b) die('ANYTLS_PORT 与其它节点端口冲突');

fs.mkdirSync(DIR, { recursive: true });

/* ---------------- 持久化状态 ---------------- */
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
state.password = state.password || crypto.randomBytes(16).toString('hex');
state.uuid = state.uuid || crypto.randomUUID();
state.wsPath = state.wsPath || '/' + crypto.randomBytes(8).toString('hex');
fs.writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });

/* ---------------- 下载二进制 ---------------- */
if (!fs.existsSync(BIN)) {
  const url = `https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/sing-box-${VERSION}-linux-${ARCH}-musl.tar.gz`;
  const tgz = path.join(DIR, 'pkg.tar.gz');
  console.log('[*] 下载 sing-box v' + VERSION + ' (' + ARCH + ')');
  sh('curl', ['-fsSL', '--retry', '3', '-o', tgz, url]);
  sh('tar', ['-xzf', tgz, '-C', DIR]);
  fs.rmSync(tgz, { force: true });

  const inner = fs.readdirSync(DIR).find((n) => n.startsWith('sing-box-'));
  if (!inner) die('解压失败');
  fs.renameSync(path.join(DIR, inner, 'sing-box'), BIN);
  fs.rmSync(path.join(DIR, inner), { recursive: true, force: true });
  fs.chmodSync(BIN, 0o755);
}

/* ---------------- 自签证书 ---------------- */
if (!fs.existsSync(CERT) || !fs.existsSync(KEY)) {
  console.log('[*] 生成自签证书');
  sh('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', KEY, '-out', CERT, '-days', '3650', '-subj', '/CN=' + SNI], { stdio: 'ignore' });
  fs.chmodSync(KEY, 0o600);
}

const SHA256 = execFileSync('openssl', ['x509', '-in', CERT, '-noout', '-fingerprint', '-sha256'])
  .toString().split('=')[1].trim().toUpperCase();

/* ---------------- 构建配置 ---------------- */
const tls = () => ({ enabled: true, alpn: ['h3'], certificate_path: CERT, key_path: KEY });
const inbounds = [];
const links = [];

if (HY2_PORT) {
  inbounds.push({
    type: 'hysteria2', tag: 'hy2-in', listen: '::', listen_port: HY2_PORT,
    users: [{ name: 'v', password: state.password }], tls: tls()
  });
  links.push(`hysteria2://${state.password}@${HOST}:${HY2_PORT}?sni=${SNI}&insecure=1&pinSHA256=${SHA256}#hy2`);
}

if (TUIC_PORT) {
  inbounds.push({
    type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: TUIC_PORT,
    users: [{ name: 'v', uuid: state.uuid, password: state.password }],
    congestion_control: 'bbr', tls: tls()
  });
  links.push(`tuic://${state.uuid}:${state.password}@${HOST}:${TUIC_PORT}?sni=${SNI}&alpn=h3&congestion_control=bbr&allow_insecure=1&pinSHA256=${SHA256}#tuic`);
}

if (ANYTLS_PORT) {
  inbounds.push({
    type: 'anytls', tag: 'anytls-in', listen: '::', listen_port: ANYTLS_PORT,
    users: [{ name: 'v', password: state.password }], tls: tls()
  });
  links.push(`anytls://${state.password}@${HOST}:${ANYTLS_PORT}?sni=${SNI}&insecure=1&pinSHA256=${SHA256}#anytls`);
}

if (ARGO_TOKEN) {
  inbounds.push({
    type: 'vless', tag: 'vless-in', listen: '127.0.0.1', listen_port: ARGO_PORT,
    users: [{ name: 'v', uuid: state.uuid }],
    transport: { type: 'ws', path: state.wsPath }
  });
  inbounds.push({ type: 'cloudflared', tag: 'argo-in', token: ARGO_TOKEN });
  links.push(`vless://${state.uuid}@${ARGO_DOMAIN}:443?encryption=none&security=tls&sni=${ARGO_DOMAIN}&pinSHA256=${SHA256}&type=ws&host=${ARGO_DOMAIN}&path=${encodeURIComponent(state.wsPath)}#argo-ws`);
}

if (!inbounds.length) die('未启用任何节点：请设置 HY2_PORT / TUIC_PORT / ANYTLS_PORT / ARGO_TOKEN');

const config = {
  log: { "disabled": true, level: 'info', timestamp: true },
  inbounds,
  outbounds: [{ type: 'direct', tag: 'direct' }]
};

fs.writeFileSync(CONF, JSON.stringify(config, null, 2), { mode: 0o600 });
fs.writeFileSync(LINKS, links.join('\n') + '\n', { mode: 0o600 });

/* ---------------- 启动 ---------------- */
console.log('\n[*] SHA-256 指纹: ' + SHA256);
console.log('[*] 密码: ' + state.password);
console.log('[*] UUID: ' + state.uuid);
if (ARGO_TOKEN) console.log('[*] WS 路径: ' + state.wsPath + '  (隧道回源请指向 http://localhost:' + ARGO_PORT + ')');
console.log('\n' + links.join('\n') + '\n');

const child = spawn(BIN, ['run', '-c', CONF], { stdio: 'inherit' });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
child.on('exit', (c) => process.exit(c || 0));
