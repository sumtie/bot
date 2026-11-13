#!/usr/bin/env node
'use strict';
/**
 * 部署 sing-box 1.11.4（hysteria2 / tuic）到本机
 * 环境变量：
 *   HY2_PORT   填端口启用 hysteria2（默认 0 关闭）
 *   TUIC_PORT  填端口启用 tuic（默认 0 关闭）
 *   PASSWORD   共用密码，留空用 state.json 里的或自动生成
 *   SNI        证书 CN/SNI，默认 www.bing.com
 *   HOST       节点域名/IP，留空自动探测
 */
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = '1.11.4';
const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'sing-box');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const CONF = path.join(DIR, 'config.json');
const NODES = path.join(DIR, 'nodes.txt');
const STATE = path.join(DIR, 'state.json');

const num = (v) => parseInt(v || '0', 10) || 0;
const HY2_PORT = num(process.env.HY2_PORT);
const TUIC_PORT = num(process.env.TUIC_PORT);
const SNI = process.env.SNI || 'www.bing.com';

const LOG_LEVEL = 'panic'; // trace | debug | info | warn | error | fatal | panic

const ARCH = { x64: 'amd64', arm64: 'arm64', arm: 'armv7', ia32: '386' }[process.arch];
if (!ARCH) { console.error('不支持的架构: ' + process.arch); process.exit(1); }
if (HY2_PORT && TUIC_PORT && HY2_PORT === TUIC_PORT) { console.error('HY2_PORT 与 TUIC_PORT 不能相同'); process.exit(1); }
if (!HY2_PORT && !TUIC_PORT) console.warn('[!] 两个端口都为空，不会启用任何节点');

fs.mkdirSync(DIR, { recursive: true });
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

// 0. 复用 / 生成凭据
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); fs.chmodSync(STATE, 0o600); };
const state = loadState();
const PASSWORD = process.env.PASSWORD || state.password || crypto.randomBytes(9).toString('base64url');
state.password = PASSWORD;

// 1. 下载并解压二进制
if (!fs.existsSync(BIN)) {
  const name = `sing-box-${VERSION}-linux-${ARCH}`;
  const tgz = path.join(DIR, 'sb.tar.gz');
  console.log('[*] 下载 ' + name);
  run('curl', ['-fL', '--retry', '3', '-o', tgz, `https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${name}.tar.gz`]);
  run('tar', ['-xzf', tgz, '-C', DIR]);
  fs.renameSync(path.join(DIR, name, 'sing-box'), BIN);
  fs.rmSync(path.join(DIR, name), { recursive: true, force: true });
  fs.rmSync(tgz);
  fs.chmodSync(BIN, 0o755);
}

// 2. 自签证书
if (!fs.existsSync(CERT) || !fs.existsSync(KEY)) {
  console.log('[*] 生成自签证书');
  run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', KEY, '-out', CERT, '-days', '3650', '-nodes',
    '-subj', `/CN=${SNI}`, '-addext', `subjectAltName=DNS:${SNI}`]);
  fs.chmodSync(KEY, 0o600);
}

// 3. 证书 SHA-256 指纹（61:BC:FD:70:...）
const FP = out('openssl', ['x509', '-in', CERT, '-noout', '-fingerprint', '-sha256']).split('=').pop().toUpperCase();

// 4. 公网地址
let HOST = process.env.HOST || '';
if (!HOST) { try { HOST = out('curl', ['-fsS', 'https://api.ipify.org']); } catch { HOST = '127.0.0.1'; } }

// 5. 生成配置与节点链接
const tls = { enabled: true, server_name: SNI, alpn: ['h3'], certificate_path: CERT, key_path: KEY };
const inbounds = [];
const links = [];

if (HY2_PORT) {
  inbounds.push({ type: 'hysteria2', tag: 'hy2-in', listen: '::', listen_port: HY2_PORT, users: [{ password: PASSWORD }], tls });
  links.push(`hysteria2://${encodeURIComponent(PASSWORD)}@${HOST}:${HY2_PORT}/?sni=${SNI}&alpn=h3&insecure=1&pinSHA256=${FP}#hy2-${HOST}`);
}

if (TUIC_PORT) {
  const uuid = state.tuicUuid || (state.tuicUuid = crypto.randomUUID());
  // 注意：1.11 起 inbound 没有 udp_relay_mode，只有客户端 outbound 才有
  inbounds.push({ type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: TUIC_PORT, users: [{ uuid, password: PASSWORD }], congestion_control: 'bbr', tls });
  links.push(`tuic://${uuid}:${encodeURIComponent(PASSWORD)}@${HOST}:${TUIC_PORT}?sni=${SNI}&alpn=h3&congestion_control=bbr&udp_relay_mode=native&allow_insecure=1&pinSHA256=${FP}#tuic-${HOST}`);
}

saveState(state); // 凭据落盘，重启复用

fs.writeFileSync(CONF, JSON.stringify({
  log: { level: LOG_LEVEL, timestamp: true },
  inbounds,
  outbounds: [{ type: 'direct', tag: 'direct' }]
}, null, 2));

// 6. 配置预校验
try {
  run(BIN, ['check', '-c', CONF]);
} catch {
  console.error('[x] 配置校验失败，见上方报错');
  process.exit(1);
}

// 7. 落地文件 + 输出
fs.writeFileSync(NODES, `# 密码: ${PASSWORD}\n# 证书 SHA-256: ${FP}\n${links.join('\n')}\n`);
console.log('\n===== 节点信息 =====');
console.log('密码:', PASSWORD);
console.log('证书 SHA-256:', FP);
links.forEach((l) => console.log(l));
console.log('凭据已保存:', STATE, '(重启自动复用)');
console.log('节点已写入:', NODES, '\n');

// 8. 启动
const child = spawn(BIN, ['run', '-c', CONF], { stdio: 'inherit' });
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => child.kill(s)));
child.on('exit', (c) => process.exit(c || 0));