---

编写nodejs代码index.js，https\://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-amd64-musl.tar.gz 部署在nodejs主机上，部署tuic和anytls协议节点，共用一个端口SERVER\_PORT，共用密码(用户填写或自动生成)，openssl无法使用，只能nodejs库自签证书。index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，简洁代码

已运行 31s · 1 步

下面是完整可运行的 `index.js`。它会在同目录创建 `.npm` 目录，把二进制、自签证书、配置和节点链接全部放进去，用 Node 内置 `crypto` 手写 DER 生成自签 X.509 证书（完全不依赖 openssl / tar 命令），然后启动 sing-box。

TUIC 走 UDP、AnyTLS 走 TCP，所以两者可以用同一个 `SERVER_PORT` 端口号互不冲突，并共用同一个密码。


```js
#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), https = require('https'),
      zlib = require('zlib'), crypto = require('crypto'), { spawn } = require('child_process');

const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'sing-box'), CERT = path.join(DIR, 'cert.pem'), KEY = path.join(DIR, 'key.pem');
const CONF = path.join(DIR, 'config.json'), LINK = path.join(DIR, 'links.txt');

const SB_URL = process.env.SB_URL ||
  'https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-amd64-musl.tar.gz';
const PORT = Number(process.env.SERVER_PORT || 8443);
const SNI = process.env.SNI || 'www.bing.com';
const PASSWORD = process.env.PASSWORD || crypto.randomBytes(12).toString('base64url');
const UUID = crypto.randomUUID();

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

/* ---------- DER 编码 ---------- */
const L = n => n < 128 ? Buffer.from([n]) : (() => {
  const b = Buffer.from(n.toString(16).padStart(2, '0'), 'hex');
  return Buffer.concat([Buffer.from([0x80 | b.length]), b]);
})();
const T = (t, v) => Buffer.concat([Buffer.from([t]), L(v.length), v]);
const S = (...p) => T(0x30, Buffer.concat(p));
const SET = (...p) => T(0x31, Buffer.concat(p));
const I = b => T(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const O = s => {
  const p = s.split('.').map(Number), out = [p[0] * 40 + p[1]];
  for (let i = 2; i < p.length; i++) { let v = p[i], t = [v & 0x7f]; v >>= 7; while (v) { t.unshift((v & 0x7f) | 0x80); v >>= 7; } out.push(...t); }
  return T(0x06, Buffer.from(out));
};
const BITS = b => T(0x03, Buffer.concat([Buffer.from([0]), b]));
const U8 = s => T(0x0c, Buffer.from(s, 'utf8'));
const OCT = b => T(0x04, b);
const TIME = d => T(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

/* ---------- 自签证书 ---------- */
function selfSigned(cn, ip) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alg = S(O('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const name = S(SET(S(O('2.5.4.3'), U8(cn))));
  const ext = T(0xa3, S(
    S(O('2.5.29.19'), Buffer.from([0x01, 0x01, 0xff]), OCT(S(Buffer.from([0x01, 0x01, 0xff])))),
    S(O('2.5.29.15'), Buffer.from([0x01, 0x01, 0xff]), OCT(Buffer.from([0x03, 0x02, 0x05, 0xa0]))),
    S(O('2.5.29.17'), OCT(S(
      T(0x82, Buffer.from(cn)),
      T(0x87, Buffer.from(ip.split('.').map(Number)))
    )))
  ));
  const tbs = S(
    T(0xa0, I(Buffer.from([2]))), I(crypto.randomBytes(16)), alg,
    name, name,
    S(TIME(new Date(Date.now() - 864e5)), TIME(new Date(Date.now() + 3650 * 864e5))),
    publicKey.export({ type: 'spki', format: 'der' }), ext
  );
  const der = S(tbs, alg, BITS(crypto.sign('sha256', tbs, privateKey)));
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
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
    const { cert, key } = selfSigned(SNI, host);
    fs.writeFileSync(CERT, cert);
    fs.writeFileSync(KEY, key, { mode: 0o600 });
  }

  const cfg = {
    log: { level: 'info', timestamp: true },
    inbounds: [
      {
        type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: PORT,
        users: [{ uuid: UUID, password: PASSWORD }],
        congestion_control: 'bbr', udp_relay_mode: 'native',
        tls: { enabled: true, server_name: SNI, alpn: ['h3'], certificate_path: CERT, key_path: KEY }
      },
      {
        type: 'anytls', tag: 'anytls-in', listen: '::', listen_port: PORT,
        users: [{ password: PASSWORD }],
        tls: { enabled: true, server_name: SNI, alpn: ['h2', 'http/1.1'], certificate_path: CERT, key_path: KEY }
      }
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }]
  };
  fs.writeFileSync(CONF, JSON.stringify(cfg, null, 2));

  const links = [
    `tuic://${UUID}:${PASSWORD}@${host}:${PORT}?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=${SNI}&allow_insecure=1#tuic-${host}`,
    `anytls://${PASSWORD}@${host}:${PORT}?security=tls&sni=${SNI}&alpn=h2%2Chttp%2F1.1&allow_insecure=1&insecure=1&type=tcp#anytls-${host}`
  ].join('\n') + '\n';
  fs.writeFileSync(LINK, links);

  console.log(`\n端口: ${PORT}  密码: ${PASSWORD}\n${links}`);

  const child = spawn(BIN, ['run', '-c', CONF], { stdio: 'inherit' });
  const bye = () => { try { child.kill('SIGTERM'); } catch {} };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  child.on('exit', c => process.exit(c || 0));
})().catch(e => { console.error(e); process.exit(1); });
```

用法：

bash

Copy code

```
SERVER_PORT=8443 PASSWORD=你的密码 SNI=www.bing.com node index.js
```

可选环境变量：`SERVER_PORT`（默认 8443）、`PASSWORD`（不填则自动生成 16 位随机串）、`SNI`（默认 www\.bing.com）、\`HOST\`（节点链接里的地址，不填自动探测公网 IP）、`SB_URL`（换版本/架构时用）。

生成物都在 `.npm/` 里：`sing-box` 二进制、`cert.pem` / `key.pem`、`config.json`、`links.txt`（含 TUIC 与 AnyTLS 两条链接，导入客户端时把 insecure 保持开启即可，因为证书是自签的）。若证书已存在会直接复用，不会重复生成。

openssl无法使用，用selfsigned，还有给我package.json

已运行 4s · 1 步

使用 `selfsigned`（基于 node-forge，纯 JS，不调用 openssl）替换手写 DER 部分，其余逻辑不变。先装依赖再运行即可。

`package.json`：

json

Copy code

```
{
  "name": "sb-tuic-anytls",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "selfsigned": "^2.4.1"
  },
  "engines": {
    "node": ">=16"
  }
}
```

`index.js`：



```js
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

  const cfg = {
    log: { level: 'info', timestamp: true },
    inbounds: [
      {
        type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: PORT,
        users: [{ uuid: UUID, password: PASSWORD }],
        congestion_control: 'bbr', udp_relay_mode: 'native',
        tls: { enabled: true, server_name: SNI, alpn: ['h3'], certificate_path: CERT, key_path: KEY }
      },
      {
        type: 'anytls', tag: 'anytls-in', listen: '::', listen_port: PORT,
        users: [{ password: PASSWORD }],
        tls: { enabled: true, server_name: SNI, alpn: ['h2', 'http/1.1'], certificate_path: CERT, key_path: KEY }
      }
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }]
  };
  fs.writeFileSync(CONF, JSON.stringify(cfg, null, 2));

  const links = [
    `tuic://${UUID}:${PASSWORD}@${host}:${PORT}?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=${SNI}&allow_insecure=1#tuic-${host}`,
    `anytls://${PASSWORD}@${host}:${PORT}?security=tls&sni=${SNI}&alpn=h2%2Chttp%2F1.1&allow_insecure=1&insecure=1&type=tcp#anytls-${host}`
  ].join('\n') + '\n';
  fs.writeFileSync(LINK, links);

  console.log(`\n端口: ${PORT}  密码: ${PASSWORD}\n${links}`);

  const child = spawn(BIN, ['run', '-c', CONF], { stdio: 'inherit' });
  const bye = () => { try { child.kill('SIGTERM'); } catch {} };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  child.on('exit', c => process.exit(c || 0));
})().catch(e => { console.error(e); process.exit(1); });
```

运行：

bash

Copy code

```
npm install
SERVER_PORT=8443 node index.js
```

注意两点：`selfsigned` 生成的是 CA:TRUE 的自签证书，客户端必须开 `allow_insecure`（链接里已带上）；证书有效期 10 年，已存在则复用不重复生成。

去掉 udp\_relay\_mode: 'native', 增加vless+ws搭配固定隧道节点，ARGO\_TOKEN有填写时启用，ARGO\_PORT默认8080，ARGO\_DOMAIN可填写或不填写，不需要下载cloudflared，sing-box本身就支持隧道了

已运行 24s · 9 个步骤

`selfsigned` 保留。sing-box 1.14 起自带 `cloudflared` inbound（内嵌隧道客户端，无需 cloudflared 二进制），但它是把隧道流量丢进路由引擎，所以需要本地起一个 vless+ws 监听在 `127.0.0.1:ARGO_PORT`，再用路由规则把隧道流量 direct 过去（CF 面板的 ingress 指向 `http://localhost:8080`）。

`package.json`：


```json
{
  "name": "sb-tuic-anytls",
  "version": "1.1.0",
  "private": true,
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "selfsigned": "^2.4.1"
  },
  "engines": {
    "node": ">=16"
  }
}
```

`index.js`：



```js
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
```

运行：


```bash
npm install
SERVER_PORT=8443 ARGO_TOKEN=你的隧道token ARGO_DOMAIN=ws.example.com node index.js
```

要点：`ARGO_TOKEN` 不填就完全不生成 vless/cloudflared 入站；`ARGO_PORT` 默认 8080 只绑回环；CF 面板里隧道 public hostname 的 service 填 `http://localhost:8080`，path 与链接里的保持一致即可。`ARGO_DOMAIN` 留空时链接里是占位符，跑起来后会打印实际 `WS_PATH`，自己补域名就行。
