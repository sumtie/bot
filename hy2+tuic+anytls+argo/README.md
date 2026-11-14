
提示词
```
编写nodejs代码index.js

curl下载https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-amd64-musl.tar.gz,

tar解压 部署在nodejs主机上，只考虑linux系统amd64和arm64。

部署hysteria2或tuic节点，端口默认都是0，HY2_PORT填写了端口就启用hysteria2节点，TUIC_PORT填写了端口就启用tuic节点，两个都填写的话不能同一个端口，共用密码(用户填写或随机生成)，uuid随机生成

openssl自签证书，计算证书sha-256，节点带上SHA-256，证书指纹格式要这种61:BC:FD:70:...，。

index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，

增加部署anytls节点，端口号可以与hysteria2/tuic共存，密码和hysteria2共用，证书和hysteria2共用

增加部署vless+ws搭配cloudflared固定隧道节点，uuid和tuicUUID共用，ARGO_TOKEN有填写就启用节点，没有就不启用，ARGO_PORT默认8080，WS_PATH随机生成，不需要额外下载cloudfalred，sing-box已经内置了cloudflared

密码、uuid、WS_PATH存到.npm/state.json里面，重启可复用

以sing-box官方最新文档https://sing-box.sagernet.org/为主，编写代码配置

简洁代码
```

已运行 40s · 1 步

下面是完整的 `index.js`。它按你要求的逻辑工作：端口为 0 就关闭对应节点，密码/UUID/WS 路径持久化到 `.npm/state.json`，二进制与证书、配置、节点链接全部落在 `.npm/` 里。


```js
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

/* ---------------- 环境变量 ---------------- */
const HY2_PORT = Number(process.env.HY2_PORT) || 0;
const TUIC_PORT = Number(process.env.TUIC_PORT) || 0;
const ANYTLS_PORT = Number(process.env.ANYTLS_PORT) || 0;
const ARGO_PORT = Number(process.env.ARGO_PORT) || 8080;
const ARGO_TOKEN = (process.env.ARGO_TOKEN || '').trim();
const ARGO_DOMAIN = (process.env.ARGO_DOMAIN || '').trim() || '<your-tunnel-domain>';
const SNI = (process.env.SNI || '').trim() || 'bing.com';
const HOST = (process.env.PUBLIC_HOST || '').trim() || '<server-ip>';

const die = (m) => { console.error('[!] ' + m); process.exit(1); };
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opt });

/* ---------------- 校验 ---------------- */
if (process.platform !== 'linux') die('只支持 Linux');
const ARCH = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!ARCH) die('只支持 amd64 / arm64，当前: ' + process.arch);

if (HY2_PORT && TUIC_PORT && HY2_PORT === TUIC_PORT) die('HY2_PORT 与 TUIC_PORT 不能相同');
for (const [a, b] of [[HY2_PORT, ANYTLS_PORT], [TUIC_PORT, ANYTLS_PORT]])
  if (a && b && a === b) die('ANYTLS_PORT 与其它节点端口冲突');

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
  links.push(`anytls://${state.password}@${HOST}:${ANYTLS_PORT}?sni=${SNI}&allowInsecure=1&fp=${SHA256}#anytls`);
}

if (ARGO_TOKEN) {
  inbounds.push({
    type: 'vless', tag: 'vless-in', listen: '127.0.0.1', listen_port: ARGO_PORT,
    users: [{ name: 'v', uuid: state.uuid }],
    transport: { type: 'ws', path: state.wsPath }
  });
  inbounds.push({ type: 'cloudflared', tag: 'argo-in', token: ARGO_TOKEN });
  links.push(`vless://${state.uuid}@${ARGO_DOMAIN}:443?encryption=none&security=tls&sni=${ARGO_DOMAIN}&fp=${SHA256}&type=ws&host=${ARGO_DOMAIN}&path=${encodeURIComponent(state.wsPath)}#argo-ws`);
}

if (!inbounds.length) die('未启用任何节点：请设置 HY2_PORT / TUIC_PORT / ANYTLS_PORT / ARGO_TOKEN');

const config = {
  log: { level: 'info', timestamp: true },
  dns: { servers: [{ type: 'local', tag: 'local' }] },
  inbounds,
  outbounds: [{ type: 'direct', tag: 'direct' }],
  route: {
    rules: [{ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' }],
    final: 'direct'
  }
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
```

用法示例：


```bash
HY2_PORT=8443 ANYTLS_PORT=9443 TUIC_PORT=10443 \
ARGO_TOKEN=eyJhIjoi... ARGO_DOMAIN=t.example.com \
PUBLIC_HOST=1.2.3.4 SNI=bing.com node index.js
```

几点说明：

+ 依赖 `curl`、`tar`、`openssl` 和 Node 18+（`randomUUID`）。musl 静态二进制在 glibc 主机上同样可用。
+ `ANYTLS_PORT` 是 anytls 的端口，缺省 0 即不启用；它会与 hy2/tuic 做端口去重校验。anytls 复用同一套密码与证书。
+ `ARGO_TOKEN` 是唯一开关，`ARGO_PORT` 默认 8080；vless+ws 只监听 `127.0.0.1`，由内置 cloudflared 通过隧道回源。需要在 Cloudflare 后台把该隧道的 Public Hostname 指向 `http://localhost:8080`，`ARGO_DOMAIN` 填那个域名。
+ 证书指纹用 `openssl x509 -fingerprint -sha256` 生成，正是 `61:BC:FD:70:...` 这种大写冒号十六进制，并写入 `pinSHA256` / `fp` 参数。
+ 密码、UUID、WS 路径全部持久化，重启不变；想换就删掉 `.npm/state.json`。
+ 配置采用 1.14 的新格式：`tls` 内嵌在 inbound 里，嗅探走 `route.rules` 的 `sniff` action，DNS 用 `type: "local"`。
