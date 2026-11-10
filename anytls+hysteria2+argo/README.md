---

编写nodejs代码index.js、package.json，https\://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-amd64-musl.tar.gz 部署在nodejs主机上，部署hysteria2和anytls协议节点，共用一个端口SERVER\_PORT，共用密码(用户填写或自动生成)，openssl无法使用时，selfsigned库自签证书，计算证书sha-256，节点带上SHA-256，证书指纹格式要这种61:BC:FD:70:...，。index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，简洁代码

已运行 36s · 1 步

下面是可直接部署的实现。两个协议里，Hysteria2 使用 UDP，AnyTLS 使用 TCP，因此可以共用同一个 `SERVER_PORT` 而不冲突。

**package.json**


```json
{
  "name": "sb-dual-node",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "selfsigned": "^2.4.1"
  }
}
```

**index.js**



```js
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const VERSION = '1.14.4';
const PKG = `sing-box-${VERSION}-linux-amd64-musl`;
const URL_TGZ = `https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${PKG}.tar.gz`;

const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'sing-box');
const CFG = path.join(DIR, 'config.json');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const NODES = path.join(DIR, 'nodes.txt');

const SNI = process.env.SNI || 'bing.com';
const PORT = parseInt(process.env.SERVER_PORT || '8443', 10);
const PASSWORD = process.env.PASSWORD || crypto.randomBytes(12).toString('base64url');

fs.mkdirSync(DIR, { recursive: true });

function download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 8) return reject(new Error('重定向过多'));
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'node' } }, res => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code)) {
        res.resume();
        return resolve(download(res.headers.location, dest, depth + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
      f.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureBinary() {
  if (fs.existsSync(BIN)) return;
  const tmp = path.join(DIR, 'sing-box.tar.gz');
  console.log('[+] 下载 sing-box', VERSION);
  await download(URL_TGZ, tmp);
  execFileSync('tar', ['-xzf', tmp, '-C', DIR, '--strip-components=1']);
  fs.rmSync(tmp, { force: true });
  fs.chmodSync(BIN, 0o755);
  execFileSync(BIN, ['version'], { stdio: 'ignore' });
}

function hasOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function makeCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return 'existing';
  if (hasOpenssl()) {
    try {
      execFileSync('openssl', ['ecparam', '-genkey', '-name', 'prime256v1', '-out', KEY]);
      execFileSync('openssl', ['req', '-new', '-x509', '-days', '3650', '-key', KEY, '-out', CERT, '-subj', `/CN=${SNI}`]);
      return 'openssl';
    } catch (e) {
      console.log('[!] openssl 失败，改用 selfsigned:', e.message);
    }
  }
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: SNI }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }]
  });
  fs.writeFileSync(CERT, pems.cert);
  fs.writeFileSync(KEY, pems.private);
  return 'selfsigned';
}

function certFingerprint() {
  const der = Buffer.from(
    fs.readFileSync(CERT, 'utf8').replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    'base64'
  );
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');
}

function getHost() {
  if (process.env.SERVER_HOST) return Promise.resolve(process.env.SERVER_HOST);
  return new Promise(resolve => {
    const req = https.get('https://api.ipify.org', res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d.trim() || '127.0.0.1'));
    });
    req.on('error', () => resolve('127.0.0.1'));
    req.setTimeout(5000, () => { req.destroy(); resolve('127.0.0.1'); });
  });
}

function buildConfig() {
  const tls = {
    enabled: true,
    server_name: SNI,
    certificate_path: CERT,
    key_path: KEY
  };
  return {
    log: { level: 'info', timestamp: true },
    inbounds: [
      {
        type: 'hysteria2',
        tag: 'hysteria2',
        listen: '::',
        listen_port: PORT,
        users: [{ password: PASSWORD }],
        masquerade: `https://${SNI}`,
        tls: { ...tls, alpn: ['h3'] }
      },
      {
        type: 'anytls',
        tag: 'anytls',
        listen: '::',
        listen_port: PORT,
        users: [{ password: PASSWORD }],
        tls
      }
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }]
  };
}

function buildNodes(host, fp) {
  const h = host.includes(':') ? `[${host}]` : host;
  const q = `insecure=1&sni=${SNI}&pinSHA256=${fp}`;
  const pw = encodeURIComponent(PASSWORD);
  return [
    `hysteria2://${pw}@${h}:${PORT}?${q}&alpn=h3#hy2-${h}-${PORT}`,
    `anytls://${pw}@${h}:${PORT}?${q}#anytls-${h}-${PORT}`
  ];
}

function run() {
  const p = spawn(BIN, ['run', '-c', CFG], { stdio: 'inherit' });
  p.on('exit', (code, sig) => {
    console.log(`[!] sing-box 退出 code=${code} sig=${sig}，3s 后重启`);
    setTimeout(run, 3000);
  });
}

(async () => {
  await ensureBinary();
  const mode = makeCert();
  const fp = certFingerprint();

  fs.writeFileSync(CFG, JSON.stringify(buildConfig(), null, 2));

  const host = await getHost();
  const nodes = buildNodes(host, fp);
  fs.writeFileSync(NODES, nodes.join('\n') + '\n');

  console.log('----------------------------------------');
  console.log('端口        :', PORT, '(UDP hysteria2 / TCP anytls)');
  console.log('密码        :', PASSWORD);
  console.log('SNI         :', SNI);
  console.log('证书来源    :', mode);
  console.log('SHA-256     :', fp);
  console.log('节点链接    :');
  nodes.forEach(n => console.log('  ' + n));
  console.log('文件目录    :', DIR);
  console.log('----------------------------------------');

  run();
})();
```

用法：



```bash
npm i
SERVER_PORT=8443 PASSWORD=你的密码 node index.js
# 或自动生成密码 / 自动探测公网 IP
SERVER_PORT=8443 node index.js
```

几点说明：

+ 证书、二进制、配置、节点链接全部落在 `index.js` 同级的 `.npm/` 里，`nodes.txt` 就是生成的链接。
+ 优先调用 openssl（EC P-256），不可用时自动降级到 `selfsigned`（2048-bit RSA），并对证书 DER 取 SHA-256，输出 `61:BC:FD:70:...` 格式写进 `pinSHA256`。
+ 两个 inbound 的 `listen` 都是 `::`，Hysteria2 走 UDP、AnyTLS 走 TCP，同一端口号即可；防火墙记得同时放行 TCP 与 UDP。
+ `SERVER_HOST` 可手动指定域名/IP（默认走 ipify 探测），`SNI` 默认 `bing.com`。
+ 进程异常退出会自动重启。建议用 pm2 或 systemd 托管，`SERVER_PORT` 请选 1024 以上端口。

增加vless+ws搭配固定隧道节点，sing-box1.14.4刚好支持，ARGO\_TOKEN有填写时启用，ARGO\_PORT默认8080，ARGO\_DOMAIN可填写或不填写

已运行 18s · 1 步

已经加上了，只有当填写 `ARGO_TOKEN` 时才会启用 VLESS+WS 和固定隧道；不填写就完全不影响原有 Hysteria2/AnyTLS。

**package.json**（不变）


```json
{
  "name": "sb-dual-node",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "selfsigned": "^2.4.1"
  }
}
```

**index.js**


```js
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const VERSION = '1.14.4';
const PKG = `sing-box-${VERSION}-linux-amd64-musl`;
const URL_TGZ = `https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${PKG}.tar.gz`;
const URL_CFD = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'sing-box');
const CFD = path.join(DIR, 'cloudflared');
const CFG = path.join(DIR, 'config.json');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const NODES = path.join(DIR, 'nodes.txt');
const ARGO_LOG = path.join(DIR, 'argo.log');

const SNI = process.env.SNI || 'bing.com';
const PORT = parseInt(process.env.SERVER_PORT || '8443', 10);
const PASSWORD = process.env.PASSWORD || crypto.randomBytes(12).toString('base64url');

const ARGO_TOKEN = process.env.ARGO_TOKEN || '';
const ARGO_PORT = parseInt(process.env.ARGO_PORT || '8080', 10);
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const UUID = process.env.UUID || crypto.randomUUID();
const WS_PATH = '/' + crypto.randomBytes(8).toString('hex');
const ARGO_ON = !!ARGO_TOKEN;

fs.mkdirSync(DIR, { recursive: true });

function download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 8) return reject(new Error('重定向过多'));
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'node' } }, res => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code)) {
        res.resume();
        return resolve(download(res.headers.location, dest, depth + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
      f.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureBinary() {
  if (fs.existsSync(BIN)) return;
  const tmp = path.join(DIR, 'sing-box.tar.gz');
  console.log('[+] 下载 sing-box', VERSION);
  await download(URL_TGZ, tmp);
  execFileSync('tar', ['-xzf', tmp, '-C', DIR, '--strip-components=1']);
  fs.rmSync(tmp, { force: true });
  fs.chmodSync(BIN, 0o755);
  execFileSync(BIN, ['version'], { stdio: 'ignore' });
}

async function ensureCloudflared() {
  if (fs.existsSync(CFD)) return;
  console.log('[+] 下载 cloudflared');
  await download(URL_CFD, CFD);
  fs.chmodSync(CFD, 0o755);
}

function hasOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function makeCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return 'existing';
  if (hasOpenssl()) {
    try {
      execFileSync('openssl', ['ecparam', '-genkey', '-name', 'prime256v1', '-out', KEY]);
      execFileSync('openssl', ['req', '-new', '-x509', '-days', '3650', '-key', KEY, '-out', CERT, '-subj', `/CN=${SNI}`]);
      return 'openssl';
    } catch (e) {
      console.log('[!] openssl 失败，改用 selfsigned:', e.message);
    }
  }
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: SNI }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }]
  });
  fs.writeFileSync(CERT, pems.cert);
  fs.writeFileSync(KEY, pems.private);
  return 'selfsigned';
}

function certFingerprint() {
  const der = Buffer.from(
    fs.readFileSync(CERT, 'utf8').replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    'base64'
  );
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');
}

function getHost() {
  if (process.env.SERVER_HOST) return Promise.resolve(process.env.SERVER_HOST);
  return new Promise(resolve => {
    const req = https.get('https://api.ipify.org', res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d.trim() || '127.0.0.1'));
    });
    req.on('error', () => resolve('127.0.0.1'));
    req.setTimeout(5000, () => { req.destroy(); resolve('127.0.0.1'); });
  });
}

function buildConfig() {
  const tls = {
    enabled: true,
    server_name: SNI,
    certificate_path: CERT,
    key_path: KEY
  };
  const inbounds = [
    {
      type: 'hysteria2',
      tag: 'hysteria2',
      listen: '::',
      listen_port: PORT,
      users: [{ password: PASSWORD }],
      masquerade: `https://${SNI}`,
      tls: { ...tls, alpn: ['h3'] }
    },
    {
      type: 'anytls',
      tag: 'anytls',
      listen: '::',
      listen_port: PORT,
      users: [{ password: PASSWORD }],
      tls
    }
  ];
  if (ARGO_ON) {
    inbounds.push({
      type: 'vless',
      tag: 'vless-ws',
      listen: '127.0.0.1',
      listen_port: ARGO_PORT,
      users: [{ name: 'argo', uuid: UUID }],
      transport: { type: 'ws', path: WS_PATH }
    });
  }
  return {
    log: { level: 'info', timestamp: true },
    inbounds,
    outbounds: [{ type: 'direct', tag: 'direct' }]
  };
}

function buildNodes(host, fp) {
  const h = host.includes(':') ? `[${host}]` : host;
  const q = `insecure=1&sni=${SNI}&pinSHA256=${fp}`;
  const pw = encodeURIComponent(PASSWORD);
  return [
    `hysteria2://${pw}@${h}:${PORT}?${q}&alpn=h3#hy2-${h}-${PORT}`,
    `anytls://${pw}@${h}:${PORT}?${q}#anytls-${h}-${PORT}`
  ];
}

function vlessNode(domain) {
  const p = encodeURIComponent(WS_PATH);
  return `vless://${UUID}@${domain}:443?encryption=none&security=tls&sni=${domain}&fp=chrome&type=ws&host=${domain}&path=${p}&allowInsecure=1#vless-ws-${domain}`;
}

let argoDomain = ARGO_DOMAIN;

function startArgo() {
  return new Promise(resolve => {
    const logStream = fs.createWriteStream(ARGO_LOG, { flags: 'a' });
    const child = spawn(CFD, ['tunnel', '--no-autoupdate', 'run', '--token', ARGO_TOKEN], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const handle = buf => {
      const s = buf.toString();
      logStream.write(s);
      process.stdout.write(s);
      if (!argoDomain) {
        const m = s.match(/"hostname"\s*:\s*"([^"]+)"/) || s.match(/https:\/\/([a-z0-9][a-z0-9.-]+\.[a-z]{2,})/i);
        if (m) { argoDomain = m[1]; resolve(argoDomain); }
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('exit', code => {
      console.log(`[!] cloudflared 退出 code=${code}，3s 后重启`);
      setTimeout(startArgo, 3000);
    });
    if (argoDomain) resolve(argoDomain);
    setTimeout(() => resolve(argoDomain), 30000);
  });
}

function run() {
  const p = spawn(BIN, ['run', '-c', CFG], { stdio: 'inherit' });
  p.on('exit', (code, sig) => {
    console.log(`[!] sing-box 退出 code=${code} sig=${sig}，3s 后重启`);
    setTimeout(run, 3000);
  });
}

(async () => {
  await ensureBinary();
  if (ARGO_ON) await ensureCloudflared();

  const mode = makeCert();
  const fp = certFingerprint();
  fs.writeFileSync(CFG, JSON.stringify(buildConfig(), null, 2));

  const host = await getHost();
  const nodes = buildNodes(host, fp);

  if (ARGO_ON) {
    console.log('[+] 启动 cloudflared 固定隧道');
    await startArgo();
    if (argoDomain) nodes.push(vlessNode(argoDomain));
    else console.log('[!] 未获取到隧道域名，请设置 ARGO_DOMAIN');
  }

  fs.writeFileSync(NODES, nodes.join('\n') + '\n');

  console.log('----------------------------------------');
  console.log('端口        :', PORT, '(UDP hysteria2 / TCP anytls)');
  console.log('密码        :', PASSWORD);
  console.log('SNI         :', SNI);
  console.log('证书来源    :', mode);
  console.log('SHA-256     :', fp);
  if (ARGO_ON) {
    console.log('Argo 本地   :', `127.0.0.1:${ARGO_PORT}  ws=${WS_PATH}`);
    console.log('UUID        :', UUID);
    console.log('Argo 域名   :', argoDomain || '(未解析)');
  }
  console.log('节点链接    :');
  nodes.forEach(n => console.log('  ' + n));
  console.log('文件目录    :', DIR);
  console.log('----------------------------------------');

  run();
})();
```

用法：


```bash
npm i
SERVER_PORT=8443 PASSWORD=你的密码 node index.js

# 开启隧道节点
SERVER_PORT=8443 ARGO_TOKEN=你的隧道token ARGO_DOMAIN=sub.example.com node index.js
```

说明：

+ VLESS 只监听 `127.0.0.1:ARGO_PORT`（默认 8080），对外完全由 cloudflared 出站，无需额外放行该端口。
+ `ARGO_DOMAIN` 不填时，会从 cloudflared 日志里自动抓取远端 ingress 的 `hostname` 或 `https://...`；抓不到就跳过 vless 链接并提示，填了则直接用它，30 秒超时不会卡死。
+ 隧道域名在 Cloudflare 侧已终止 TLS，所以 vless 链接用 `security=tls` + 443 + `sni/host` 指向该域名，本地为明文 WS。
+ `WS_PATH` 每次启动随机生成，`UUID` 可自定义（`UUID=` 环境变量），不填自动生成，都写进 `nodes.txt`。
+ cloudflared 日志落在 `.npm/argo.log`，进程退出同样自动重启。

不需要cloudflared，sing-box本身已经支持了

已运行 30s · 10 个步骤

sing-box 1.14.0 内置了 `cloudflared` inbound（文档），隧道客户端直接由 sing-box 自己跑，不再需要外部二进制。已改成这样：

**index.js**


```js
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const VERSION = '1.14.4';
const PKG = `sing-box-${VERSION}-linux-amd64-musl`;
const URL_TGZ = `https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${PKG}.tar.gz`;

const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'sing-box');
const CFG = path.join(DIR, 'config.json');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const NODES = path.join(DIR, 'nodes.txt');
const SB_LOG = path.join(DIR, 'sing-box.log');

const SNI = process.env.SNI || 'bing.com';
const PORT = parseInt(process.env.SERVER_PORT || '8443', 10);
const PASSWORD = process.env.PASSWORD || crypto.randomBytes(12).toString('base64url');

const ARGO_TOKEN = process.env.ARGO_TOKEN || '';
const ARGO_PORT = parseInt(process.env.ARGO_PORT || '8080', 10);
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_PROTOCOL = process.env.ARGO_PROTOCOL || ''; // quic | http2
const UUID = process.env.UUID || crypto.randomUUID();
const WS_PATH = '/' + crypto.randomBytes(8).toString('hex');
const ARGO_ON = !!ARGO_TOKEN;

let argoDomain = ARGO_DOMAIN;

fs.mkdirSync(DIR, { recursive: true });

function download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 8) return reject(new Error('重定向过多'));
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'node' } }, res => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code)) {
        res.resume();
        return resolve(download(res.headers.location, dest, depth + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
      f.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureBinary() {
  if (fs.existsSync(BIN)) return;
  const tmp = path.join(DIR, 'sing-box.tar.gz');
  console.log('[+] 下载 sing-box', VERSION);
  await download(URL_TGZ, tmp);
  execFileSync('tar', ['-xzf', tmp, '-C', DIR, '--strip-components=1']);
  fs.rmSync(tmp, { force: true });
  fs.chmodSync(BIN, 0o755);
  execFileSync(BIN, ['version'], { stdio: 'ignore' });
}

function hasOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function makeCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return 'existing';
  if (hasOpenssl()) {
    try {
      execFileSync('openssl', ['ecparam', '-genkey', '-name', 'prime256v1', '-out', KEY]);
      execFileSync('openssl', ['req', '-new', '-x509', '-days', '3650', '-key', KEY, '-out', CERT, '-subj', `/CN=${SNI}`]);
      return 'openssl';
    } catch (e) {
      console.log('[!] openssl 失败，改用 selfsigned:', e.message);
    }
  }
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: SNI }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }]
  });
  fs.writeFileSync(CERT, pems.cert);
  fs.writeFileSync(KEY, pems.private);
  return 'selfsigned';
}

function certFingerprint() {
  const der = Buffer.from(
    fs.readFileSync(CERT, 'utf8').replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    'base64'
  );
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');
}

function getHost() {
  if (process.env.SERVER_HOST) return Promise.resolve(process.env.SERVER_HOST);
  return new Promise(resolve => {
    const req = https.get('https://api.ipify.org', res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d.trim() || '127.0.0.1'));
    });
    req.on('error', () => resolve('127.0.0.1'));
    req.setTimeout(5000, () => { req.destroy(); resolve('127.0.0.1'); });
  });
}

function buildConfig() {
  const tls = {
    enabled: true,
    server_name: SNI,
    certificate_path: CERT,
    key_path: KEY
  };
  const inbounds = [
    {
      type: 'hysteria2',
      tag: 'hysteria2',
      listen: '::',
      listen_port: PORT,
      users: [{ password: PASSWORD }],
      masquerade: `https://${SNI}`,
      tls: { ...tls, alpn: ['h3'] }
    },
    {
      type: 'anytls',
      tag: 'anytls',
      listen: '::',
      listen_port: PORT,
      users: [{ password: PASSWORD }],
      tls
    }
  ];
  const route = { rules: [] };

  if (ARGO_ON) {
    inbounds.push({
      type: 'vless',
      tag: 'vless-ws',
      listen: '127.0.0.1',
      listen_port: ARGO_PORT,
      users: [{ name: 'argo', uuid: UUID }],
      transport: { type: 'ws', path: WS_PATH }
    });

    const cf = { type: 'cloudflared', tag: 'argo', token: ARGO_TOKEN, ha_connections: 2 };
    if (ARGO_PROTOCOL) cf.protocol = ARGO_PROTOCOL;
    inbounds.push(cf);

    // 隧道流量统一落到本地 vless-ws
    route.rules.push({
      inbound: ['argo'],
      action: 'route',
      outbound: 'direct',
      override_address: '127.0.0.1',
      override_port: ARGO_PORT
    });
  }

  return {
    log: { level: 'info', timestamp: true },
    inbounds,
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route
  };
}

function buildNodes(host, fp) {
  const h = host.includes(':') ? `[${host}]` : host;
  const q = `insecure=1&sni=${SNI}&pinSHA256=${fp}`;
  const pw = encodeURIComponent(PASSWORD);
  const list = [
    `hysteria2://${pw}@${h}:${PORT}?${q}&alpn=h3#hy2-${h}-${PORT}`,
    `anytls://${pw}@${h}:${PORT}?${q}#anytls-${h}-${PORT}`
  ];
  if (ARGO_ON && argoDomain) {
    const p = encodeURIComponent(WS_PATH);
    list.push(`vless://${UUID}@${argoDomain}:443?encryption=none&security=tls&sni=${argoDomain}&fp=chrome&type=ws&host=${argoDomain}&path=${p}&allowInsecure=1#vless-ws-${argoDomain}`);
  }
  return list;
}

let baseHost = '127.0.0.1';
let fingerprint = '';

function writeNodes() {
  const nodes = buildNodes(baseHost, fingerprint);
  fs.writeFileSync(NODES, nodes.join('\n') + '\n');
  return nodes;
}

function run() {
  const logStream = fs.createWriteStream(SB_LOG, { flags: 'a' });
  const p = spawn(BIN, ['run', '-c', CFG], { stdio: ['ignore', 'pipe', 'pipe'] });

  const handle = buf => {
    const s = buf.toString();
    logStream.write(s);
    process.stdout.write(s);
    if (ARGO_ON && !argoDomain) {
      const m = s.match(/hostname["\s:=]+([a-z0-9][a-z0-9.-]+\.[a-z]{2,})/i);
      if (m) {
        argoDomain = m[1];
        console.log('[+] 从日志解析到隧道域名:', argoDomain);
        writeNodes();
      }
    }
  };
  p.stdout.on('data', handle);
  p.stderr.on('data', handle);

  p.on('exit', (code, sig) => {
    console.log(`[!] sing-box 退出 code=${code} sig=${sig}，3s 后重启`);
    setTimeout(run, 3000);
  });
}

(async () => {
  await ensureBinary();

  const mode = makeCert();
  fingerprint = certFingerprint();
  fs.writeFileSync(CFG, JSON.stringify(buildConfig(), null, 2));

  baseHost = await getHost();
  const nodes = writeNodes();

  console.log('----------------------------------------');
  console.log('端口        :', PORT, '(UDP hysteria2 / TCP anytls)');
  console.log('密码        :', PASSWORD);
  console.log('SNI         :', SNI);
  console.log('证书来源    :', mode);
  console.log('SHA-256     :', fingerprint);
  if (ARGO_ON) {
    console.log('Argo 本地   :', `127.0.0.1:${ARGO_PORT}  ws=${WS_PATH}`);
    console.log('UUID        :', UUID);
    console.log('Argo 域名   :', argoDomain || '(未填写 ARGO_DOMAIN，等待日志解析)');
  }
  console.log('节点链接    :');
  nodes.forEach(n => console.log('  ' + n));
  console.log('文件目录    :', DIR);
  console.log('----------------------------------------');

  run();
})();
```

说明：

+ 去掉了 cloudflared 下载与外部进程，改为 `cloudflared` inbound + `token`，隧道由 sing-box 内部维持。
+ 隧道入口流量用一条 route 规则固定改写到 `127.0.0.1:ARGO_PORT`，命中本地 `vless-ws` inbound；第二跳（vless 进来）不再匹配该规则，默认走 direct，不会成环。
+ `ARGO_PORT` 默认 8080，只在 127.0.0.1 上监听，防火墙无需放行。
+ `ARGO_DOMAIN` 不填时会从 sing-box 日志里尝试抓 `hostname`，抓不到就只输出前两个节点；填了则直接生成 vless 链接。
+ Cloudflare 后台该隧道 public hostname 的服务地址填 `http://localhost:8080`。
+ `ARGO_PROTOCOL` 可选 `quic`/`http2`，网络屏蔽 UDP 时用 `http2`。
+ 日志统一写 `.npm/sing-box.log`，异常退出自动重启。

