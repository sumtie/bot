#!/usr/bin/env node
'use strict';
/**
 * sing-box 多协议一键部署 (hysteria2 / tuic / anytls / vless+ws+argo)
 * 仅支持 Linux amd64 / arm64
 *
 * 环境变量:
 *   HY2_PORT     hysteria2 端口   (0 或留空 = 关闭)
 *   TUIC_PORT    tuic 端口        (0 或留空 = 关闭，不可与 HY2_PORT 相同)
 *   ANYTLS_PORT  anytls 端口      (0 或留空 = 关闭，可与 hy2/tuic 共存)
 *   ARGO_PORT    vless+ws 本地端口 (默认 8080)
 *   ARGO_TOKEN   cloudflared 固定隧道 token (留空 = 临时隧道)
 *   ARGO_DOMAIN  固定隧道域名 (可选)
 *   PASSWORD     共用密码 (留空 = 随机生成)
 *   UUID         tuic/vless 共用 uuid (留空 = 随机生成)
 *   SERVER_IP    节点链接使用的公网地址 (留空 = 自动获取)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const SB_VER = '1.14.4';
const SNI = 'www.bing.com';

const DIR = path.join(__dirname, '.npm');
fs.mkdirSync(DIR, { recursive: true });

const ARCH = { x64: 'amd64', arm64: 'arm64' }[os.arch()];
if (!ARCH || os.platform() !== 'linux') {
  console.error('仅支持 Linux amd64 / arm64');
  process.exit(1);
}

const sh = (c) => execSync(c, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

/* ---------------- 状态复用 ---------------- */
const STATE = path.join(DIR, 'state.json');
let st = {};
try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}

const password = process.env.PASSWORD || st.password || crypto.randomBytes(16).toString('hex');
const uuid = process.env.UUID || st.uuid || crypto.randomUUID();
const wsPath = '/' + (st.wsPath ? String(st.wsPath).replace(/^\//, '') : crypto.randomBytes(6).toString('hex'));
fs.writeFileSync(STATE, JSON.stringify({ password, uuid, wsPath }, null, 2), { mode: 0o600 });

/* ---------------- 端口 ---------------- */
const P = (v) => { const n = parseInt(v, 10); return n > 0 && n < 65536 ? n : 0; };
const hy2Port = P(process.env.HY2_PORT) || 0;
const tuicPort = P(process.env.TUIC_PORT) || 0;
const anyPort = P(process.env.ANYTLS_PORT) || 0;
const argoPort = P(process.env.ARGO_PORT) || 8080;

const used = {};
// for (const [k, p] of Object.entries({ HY2_PORT: hy2Port, TUIC_PORT: tuicPort, ANYTLS_PORT: anyPort, ARGO_PORT: argoPort })) {
//   if (!p) continue;
//   if (used[p]) { console.error(`端口冲突: ${k} 与 ${used[p]} 都是 ${p}`); process.exit(1); }
//   used[p] = k;
// }
for (const [k, p] of Object.entries({ HY2_PORT: hy2Port, TUIC_PORT: tuicPort, ARGO_PORT: argoPort })) {
  if (!p) continue;
  if (used[p]) { console.error(`端口冲突: ${k} 与 ${used[p]} 都是 ${p}`); process.exit(1); }
  used[p] = k;
}

/* ---------------- 下载 sing-box ---------------- */
const SB = path.join(DIR, 'sing-box');
if (!fs.existsSync(SB)) {
  const tgz = path.join(DIR, 'sb.tar.gz');
  const name = `sing-box-${SB_VER}-linux-${ARCH}-musl`;
  sh(`curl -fsSL -o ${tgz} https://github.com/SagerNet/sing-box/releases/download/v${SB_VER}/${name}.tar.gz`);
  sh(`tar -xzf ${tgz} -C ${DIR}`);
  fs.renameSync(path.join(DIR, name, 'sing-box'), SB);
  fs.rmSync(tgz, { force: true });
  fs.rmSync(path.join(DIR, name), { recursive: true, force: true });
  fs.chmodSync(SB, 0o755);
}

/* ---------------- 自签证书 (hy2 / anytls 共用) ---------------- */
let crt = null, key = null, pin = null;
if (hy2Port || anyPort) {
  key = path.join(DIR, 'key.pem');
  crt = path.join(DIR, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(crt)) {
    sh(`openssl ecparam -genkey -name prime256v1 -out ${key}`);
    sh(`openssl req -new -x509 -days 3650 -key ${key} -out ${crt} -subj "/CN=${SNI}"`);
  }
  pin = sh(`openssl x509 -in ${crt} -noout -fingerprint -sha256`).split('=')[1].trim();
}

/* ---------------- 生成配置 ---------------- */
const inbounds = [];

if (hy2Port) inbounds.push({
  type: 'hysteria2', tag: 'hy2', listen: '::', listen_port: hy2Port,
  users: [{ password }],
  tls: { enabled: true, server_name: SNI, alpn: ['h3'], certificate_path: crt, key_path: key }
});

if (tuicPort) inbounds.push({
  type: 'tuic', tag: 'tuic', listen: '::', listen_port: tuicPort,
  users: [{ uuid, password }],
  congestion_control: 'bbr',
  tls: { enabled: true, server_name: SNI, alpn: ['h3'], certificate_path: crt, key_path: key }
});

if (anyPort) inbounds.push({
  type: 'anytls', tag: 'anytls', listen: '::', listen_port: anyPort,
  users: [{ password }],
  tls: { enabled: true, server_name: SNI, certificate_path: crt, key_path: key }
});

inbounds.push({
  type: 'vless', tag: 'vless-ws', listen: '127.0.0.1', listen_port: argoPort,
  users: [{ uuid }],
  transport: { type: 'ws', path: wsPath, early_data_header_name: 'Sec-WebSocket-Protocol' }
});

const config = {
  log: { disabled: true, level: 'info', timestamp: true },
  inbounds,
  outbounds: [{ type: 'direct', tag: 'direct' }],
};

const CFG = path.join(DIR, 'config.json');
fs.writeFileSync(CFG, JSON.stringify(config, null, 2));

try {
  execSync(`${SB} check -c ${CFG}`, { stdio: ['ignore', 'inherit', 'inherit'] });
} catch {
  console.error('配置校验失败');
  process.exit(1);
}

/* ---------------- 启动 sing-box ---------------- */
const sb = spawn(SB, ['run', '-c', CFG], { stdio: ['ignore', 'inherit', 'inherit'] });
const children = [sb];

/* ---------------- cloudflared ---------------- */
const CF = path.join(DIR, 'cloudflared');
if (!fs.existsSync(CF)) {
  sh(`curl -fsSL -o ${CF} https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`);
  fs.chmodSync(CF, 0o755);
}

const LOG = path.join(DIR, 'argo.log');
fs.writeFileSync(LOG, '');

const argoArgs = ['--no-autoupdate', '--logfile', LOG, '--loglevel', 'info', 'tunnel'];
if (process.env.ARGO_TOKEN) {
  argoArgs.push('run', '--token', process.env.ARGO_TOKEN, '--url', `http://127.0.0.1:${argoPort}`);
} else {
  argoArgs.push('--url', `http://127.0.0.1:${argoPort}`);
}
const argo = spawn(CF, argoArgs, { stdio: 'ignore' });
children.push(argo);

const waitDomain = () => new Promise((resolve) => {
  const t0 = Date.now();
  const timer = setInterval(() => {
    let txt = '';
    try { txt = fs.readFileSync(LOG, 'utf8'); } catch {}
    const m = txt.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) { clearInterval(timer); resolve(m[0].replace('https://', '')); }
    else if (Date.now() - t0 > 90000) { clearInterval(timer); resolve(null); }
  }, 1000);
});

process.on('SIGINT', () => { children.forEach(c => c.kill('SIGKILL')); process.exit(0); });
process.on('SIGTERM', () => { children.forEach(c => c.kill('SIGKILL')); process.exit(0); });

/* ---------------- 输出节点 ---------------- */
(async () => {
  const ip = process.env.SERVER_IP || sh('curl -fsS https://api.ipify.org');
  const host = process.env.ARGO_DOMAIN || (process.env.ARGO_TOKEN ? null : await waitDomain());

  const links = [];
  if (hy2Port) links.push(
    `hysteria2://${encodeURIComponent(password)}@${ip}:${hy2Port}/?sni=${SNI}&alpn=h3&insecure=1&pinSHA256=${pin}#hy2-${ip}`
  );
  if (tuicPort) links.push(
    `tuic://${uuid}:${encodeURIComponent(password)}@${ip}:${tuicPort}?sni=${SNI}&alpn=h3&congestion_control=bbr&allow_insecure=1&pinSHA256=${pin}#tuic-${ip}`
  );
  if (anyPort) links.push(
    `anytls://${encodeURIComponent(password)}@${ip}:${anyPort}?sni=${SNI}&insecure=1&pinSHA256=${pin}#anytls-${ip}`
  );
  if (host) links.push(
    `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&fp=chrome&type=ws&path=${encodeURIComponent(wsPath)}&host=${host}#vless-ws-${host}`
  );

  fs.writeFileSync(path.join(DIR, 'nodes.txt'), links.join('\n') + '\n', { mode: 0o600 });

  console.log('\n================ 节点 ================');
  console.log(links.join('\n\n') || '未启用任何节点');
  console.log('======================================');
  console.log(`证书 SHA-256: ${pin || '-'}`);
  if (!host && !process.env.ARGO_TOKEN) console.log('临时隧道域名未取到，稍后查看 .npm/argo.log');
  console.log('sing-box 运行中，Ctrl+C 退出\n');
})();
