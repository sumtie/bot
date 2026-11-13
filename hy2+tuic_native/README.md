
编写nodejs代码index.js，curl下载sing-box 1.11.4, tar解压 部署在nodejs主机上，部署hysteria2或tuic节点，端口默认都是0，HY2\_PORT填写了端口就启用hysteria2节点，TUIC\_PORT填写了端口就启用tuic节点，两个都填写的话不能同一个端口，共用密码(用户填写或自动生成)，openssl自签证书，计算证书sha-256，节点带上SHA-256，证书指纹格式要这种61:BC:FD:70:...，。index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，简洁代码。

已运行 16s · 1 步

# index.js



```js
#!/usr/bin/env node
'use strict';
/**
 * 部署 sing-box 1.11.4（hysteria2 / tuic）到本机
 * 环境变量：
 *   HY2_PORT   填端口启用 hysteria2（默认 0 关闭）
 *   TUIC_PORT  填端口启用 tuic（默认 0 关闭）
 *   PASSWORD   共用密码，留空自动生成
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

const num = (v) => parseInt(v || '0', 10) || 0;
const HY2_PORT = num(process.env.HY2_PORT);
const TUIC_PORT = num(process.env.TUIC_PORT);
const SNI = process.env.SNI || 'www.bing.com';
const PASSWORD = process.env.PASSWORD || crypto.randomBytes(9).toString('base64url');

const ARCH = { x64: 'amd64', arm64: 'arm64', arm: 'armv7', ia32: '386' }[process.arch];
if (!ARCH) { console.error('不支持的架构: ' + process.arch); process.exit(1); }
if (HY2_PORT && TUIC_PORT && HY2_PORT === TUIC_PORT) { console.error('HY2_PORT 与 TUIC_PORT 不能相同'); process.exit(1); }
if (!HY2_PORT && !TUIC_PORT) console.warn('[!] 两个端口都为空，不会启用任何节点');

fs.mkdirSync(DIR, { recursive: true });
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

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
  const uuid = crypto.randomUUID();
  inbounds.push({ type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: TUIC_PORT, users: [{ uuid, password: PASSWORD }], congestion_control: 'bbr', udp_relay_mode: 'native', tls });
  links.push(`tuic://${uuid}:${encodeURIComponent(PASSWORD)}@${HOST}:${TUIC_PORT}?sni=${SNI}&alpn=h3&congestion_control=bbr&udp_relay_mode=native&allow_insecure=1&pinSHA256=${FP}#tuic-${HOST}`);
}

fs.writeFileSync(CONF, JSON.stringify({
  log: { level: 'warn', timestamp: true },
  inbounds,
  outbounds: [{ type: 'direct', tag: 'direct' }]
}, null, 2));

// 6. 落地文件 + 输出
fs.writeFileSync(NODES, `# 密码: ${PASSWORD}\n# 证书 SHA-256: ${FP}\n${links.join('\n')}\n`);
console.log('\n===== 节点信息 =====');
console.log('密码:', PASSWORD);
console.log('证书 SHA-256:', FP);
links.forEach((l) => console.log(l));
console.log('节点已写入:', NODES, '\n');

// 7. 启动
const child = spawn(BIN, ['run', '-c', CONF], { stdio: 'inherit' });
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => child.kill(s)));
child.on('exit', (c) => process.exit(c || 0));
```

## 用法




```bash
npm i -g pm2            # 可选，守护进程
sudo HY2_PORT=8443 PASSWORD='yourpass' node index.js
```

+ 只开 TUIC：`sudo TUIC_PORT=8444 node index.js`
+ 两个都开：`sudo HY2_PORT=8443 TUIC_PORT=8444 node index.js`（端口相同会直接报错退出）
+ 密码留空自动生成，`HOST` 不填自动探测公网 IP

## 说明

+ 二进制、`cert.pem`、`key.pem`、`config.json`、`nodes.txt` 全部落在脚本同目录的 `.npm/` 里，重复执行不会重复下载、不会覆盖证书（保证指纹稳定）。
+ 指纹用 `openssl x509 -fingerprint -sha256` 输出的大写冒号十六进制，直接拼进 `pinSHA256=`，客户端可做证书固定。
+ 低于 1024 的端口需 root；运行前确认已装 `curl`、`tar`、`openssl`。
+ TUIC 本身没有官方 pin 参数，链接里附 `pinSHA256` 供参考，实际靠 `allow_insecure=1` 放行自签证书；需要严格校验时在客户端把指纹填进 `certificate_public_key_sha256`。

启动报错fatal，sing-box已经没有udp\_relay\_mode: 'native',

已运行 21s · 7 个步骤

`udp_relay_mode` 在 sing-box 1.11 只存在于 TUIC **outbound**，inbound 结构体里已经没有了（`option/tuic.go` 的 `TUICInboundOptions` 只有 users / congestion\_control / auth\_timeout / zero\_rtt\_handshake / heartbeat / tls）。所以把它从服务端 inbound 里删掉即可 —— 链接里的 `udp_relay_mode=native` 是客户端参数，仍然保留。

改动就这一行：



```js
// 旧（inbound 会 fatal）
inbounds.push({ type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: TUIC_PORT, users: [{ uuid, password: PASSWORD }], congestion_control: 'bbr', udp_relay_mode: 'native', tls });

// 新
inbounds.push({ type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: TUIC_PORT, users: [{ uuid, password: PASSWORD }], congestion_control: 'bbr', tls });
```

顺便加了 `sing-box check` 预校验，以后字段写错会立刻报出来而不是跑到一半 fatal。

# index.js（修正版）



```js
#!/usr/bin/env node
'use strict';
/**
 * 部署 sing-box 1.11.4（hysteria2 / tuic）到本机
 * 环境变量：
 *   HY2_PORT   填端口启用 hysteria2（默认 0 关闭）
 *   TUIC_PORT  填端口启用 tuic（默认 0 关闭）
 *   PASSWORD   共用密码，留空自动生成
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

const num = (v) => parseInt(v || '0', 10) || 0;
const HY2_PORT = num(process.env.HY2_PORT);
const TUIC_PORT = num(process.env.TUIC_PORT);
const SNI = process.env.SNI || 'www.bing.com';
const PASSWORD = process.env.PASSWORD || crypto.randomBytes(9).toString('base64url');

const ARCH = { x64: 'amd64', arm64: 'arm64', arm: 'armv7', ia32: '386' }[process.arch];
if (!ARCH) { console.error('不支持的架构: ' + process.arch); process.exit(1); }
if (HY2_PORT && TUIC_PORT && HY2_PORT === TUIC_PORT) { console.error('HY2_PORT 与 TUIC_PORT 不能相同'); process.exit(1); }
if (!HY2_PORT && !TUIC_PORT) console.warn('[!] 两个端口都为空，不会启用任何节点');

fs.mkdirSync(DIR, { recursive: true });
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

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
  const uuid = crypto.randomUUID();
  // 注意：1.11 起 inbound 没有 udp_relay_mode，只有客户端 outbound 才有
  inbounds.push({ type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: TUIC_PORT, users: [{ uuid, password: PASSWORD }], congestion_control: 'bbr', tls });
  links.push(`tuic://${uuid}:${encodeURIComponent(PASSWORD)}@${HOST}:${TUIC_PORT}?sni=${SNI}&alpn=h3&congestion_control=bbr&udp_relay_mode=native&allow_insecure=1&pinSHA256=${FP}#tuic-${HOST}`);
}

fs.writeFileSync(CONF, JSON.stringify({
  log: { level: 'warn', timestamp: true },
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
console.log('节点已写入:', NODES, '\n');

// 8. 启动
const child = spawn(BIN, ['run', '-c', CONF], { stdio: 'inherit' });
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => child.kill(s)));
child.on('exit', (c) => process.exit(c || 0));
```

如果你的客户端走 quic 模式（UDP over stream），把链接里的 `udp_relay_mode=native` 改成 `quic` 即可，服务端不用动。

PASSWORD和uuid存到./npm/state.json，重启可复用，简洁代码

已运行 13s · 1 步

状态文件放在部署目录里（`.npm/state.json`，权限 600）。首次运行生成后写入，之后重启直接复用；用环境变量 `PASSWORD` 传入会覆盖并同步更新状态文件。

# index.js


```js
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
  log: { level: 'warn', timestamp: true },
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
```

要点：

+ `state.json` 只存 `password` 和 `tuicUuid`，两者都只在缺失时生成，已有就原样读回，节点链接因此保持稳定。
+ 优先级：`PASSWORD` 环境变量 > `state.json` > 随机生成；走环境变量时会覆盖旧值并写回，方便主动换密码。
+ 想彻底换一套凭据就删掉 `.npm/state.json`（证书和指纹同理，删 `cert.pem`/`key.pem`）。
+ `state.json` 和 `key.pem` 都是 600，别把它塞进公开仓库。
