```
编写nodejs代码index.js

curl下载https\://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-amd64-musl.tar.gz,

tar解压 部署在nodejs主机上，只考虑linux系统amd64和arm64。

部署hysteria2或tuic节点，端口默认都是0，HY2\_PORT填写了端口就启用hysteria2节点，TUIC\_PORT填写了端口就启用tuic节点，两个都填写的话不能同一个端口，共用密码(用户填写或随机生成)，uuid随机生成

openssl自签证书，计算证书sha-256，节点带上SHA-256，证书指纹格式要这种61:BC:FD:70:...，。

index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，

增加部署anytls节点，端口号可以与hysteria2/tuic共存，密码和hysteria2共用，证书和hysteria2共用

增加部署vless+ws搭配cloudflared隧道节点，uuid和tuicUUID共用，ARGO\_TOKEN有填写就固定隧道，没有就临时隧道，ARGO\_DOMAIN可填可不填，ARGO\_PORT默认8080，WS\_PATH随机生成，cloudflared只把日志写到.npm/argo.log，临时隧道域名从.npm/argo.log获取

密码、uuid、WS\_PATH存到.npm/state.json里面，重启可复用

以sing-box官方最新文档https\://sing-box.sagernet.org/为主，编写代码配置

简洁代码
```


已运行 37s · 1 步

下面是完整代码。把它保存为 `index.js`，并与 `.npm` 放在同一目录下运行。


```js
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
const hy2Port = P(process.env.HY2_PORT);
const tuicPort = P(process.env.TUIC_PORT);
const anyPort = P(process.env.ANYTLS_PORT);
const argoPort = P(process.env.ARGO_PORT) || 8080;

const used = {};
for (const [k, p] of Object.entries({ HY2_PORT: hy2Port, TUIC_PORT: tuicPort, ANYTLS_PORT: anyPort, ARGO_PORT: argoPort })) {
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
  congestion_control: 'bbr', auth_timeout: '3s', heartbeat: '10s',
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
  log: { level: 'info', timestamp: true },
  dns: { servers: [{ type: 'tls', tag: 'dns', server: '8.8.8.8' }] },
  inbounds,
  outbounds: [{ type: 'direct', tag: 'direct' }],
  route: { rules: [{ action: 'sniff' }, { action: 'resolve', server: 'dns' }] }
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
```

使用示例：


```bash
HY2_PORT=8443 ANYTLS_PORT=9443 node index.js
```

说明几个实现要点：

+ 二进制、证书、`config.json`、`argo.log`、`state.json`、`nodes.txt` 全部落在 `.npm/` 内；`state.json` 权限 `0600`，密码/uuid/wsPath 重启复用。
+ 证书指纹取自 `openssl x509 -fingerprint -sha256`，天然就是 `61:BC:FD:70:...` 冒号大写格式，直接拼进链接的 `pinSHA256`。
+ vless+ws 走明文 HTTP 只监听 `127.0.0.1`，TLS 由 cloudflared 边缘终结；有 `ARGO_TOKEN` 走固定隧道（可配 `ARGO_DOMAIN`），无 token 走临时隧道并从 `argo.log` 轮询域名。
+ 配置写完先跑 `sing-box check` 再启动，避免带病运行。
