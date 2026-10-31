编写nodejs代码，部署在nodejs类主机上，xray v26.10.29+cloudflare隧道，搭建vless+xhttp搭配cloudflare隧道节点，默认端口号ARGO_PORT为8080，必须填写ARGO_TOKEN，启动固定隧道，ARGO_DOMAIN可填可不填写。代码执行过程所有文件放到.npm目录下，.npm与index.js在同一级目录，uuid重启可复用，尽量简约代码少代码实现。

已运行 16s · 1 步

下面是极简实现。核心思路：一个 `index.js` 搞定全部——所有文件落在 `.npm`，UUID 落盘复用，Xray 只监听 `127.0.0.1:ARGO_PORT`（明文 xhttp），cloudflared 用 `ARGO_TOKEN` 起固定隧道把本地端口打出去。节点侧 TLS 由 Cloudflare 边缘终结，所以 Xray 不需要证书。

**package.json**


```
{
  "name": "argo-xhttp",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": { "start": "node index.js" }
}
```

**index.js**


```
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const XRAY_VER = 'v26.10.29';
const ARM = process.arch === 'arm64';
const DIR = path.join(process.cwd(), '.npm');
const PORT = Number(process.env.ARGO_PORT || 8080);
const TOKEN = process.env.ARGO_TOKEN || '';
const DOMAIN = (process.env.ARGO_DOMAIN || '').trim();
const XRAY = path.join(DIR, 'xray');
const CF = path.join(DIR, 'cloudflared');
const CONF = path.join(DIR, 'config.json');
const UID = path.join(DIR, 'uuid');

if (!TOKEN) { console.error('[!] 必须设置 ARGO_TOKEN'); process.exit(1); }
fs.mkdirSync(DIR, { recursive: true });

// UUID 落盘，重启复用
let uuid = fs.existsSync(UID) ? fs.readFileSync(UID, 'utf8').trim() : '';
if (!uuid) { uuid = crypto.randomUUID(); fs.writeFileSync(UID, uuid); }

function get(url, n = 0) {
  return new Promise((ok, no) => {
    https.get(url, { headers: { 'user-agent': 'node' } }, r => {
      if (r.statusCode > 300 && r.statusCode < 400 && r.headers.location && n < 5) {
        r.resume(); return ok(get(new URL(r.headers.location, url).href, n + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return no(new Error('HTTP ' + r.statusCode)); }
      const c = []; r.on('data', d => c.push(d)); r.on('end', () => ok(Buffer.concat(c)));
    }).on('error', no);
  });
}

// 极简 zip 解包（仅取单文件）
function unzip(buf, dest) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('bad zip');
  let p = buf.readUInt32LE(e + 16);
  for (let i = 0, n = buf.readUInt16LE(e + 10); i < n; i++) {
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42), m = buf.readUInt16LE(p + 10), cs = buf.readUInt32LE(p + 20);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const s = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(s, s + cs);
    if (!name.endsWith('/')) fs.writeFileSync(path.join(dest, path.basename(name)), m === 0 ? raw : zlib.inflateRawSync(raw));
    p += 46 + nl + el + cl;
  }
}

async function ensure() {
  if (!fs.existsSync(XRAY)) {
    console.log('[*] 拉取 Xray ' + XRAY_VER);
    unzip(await get(`https://github.com/XTLS/Xray-core/releases/download/${XRAY_VER}/Xray-linux-${ARM ? 'arm64-v8a' : '64'}.zip`), DIR);
    fs.chmodSync(XRAY, 0o755);
  }
  if (!fs.existsSync(CF)) {
    console.log('[*] 拉取 cloudflared');
    fs.writeFileSync(CF, await get(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARM ? 'arm64' : 'amd64'}`));
    fs.chmodSync(CF, 0o755);
  }
}

function link() {
  const h = DOMAIN || '<你的隧道域名>';
  return `vless://${uuid}@${h}:443?encryption=none&security=tls&sni=${h}&fp=chrome&alpn=h2&type=xhttp&host=${h}&path=%2F&mode=auto#argo-xhttp`;
}

async function main() {
  await ensure();

  fs.writeFileSync(CONF, JSON.stringify({
    log: { loglevel: 'warning' },
    inbounds: [{
      listen: '127.0.0.1',
      port: PORT,
      protocol: 'vless',
      settings: { clients: [{ id: uuid }], decryption: 'none' },
      streamSettings: { network: 'xhttp', xhttpSettings: { path: '/', mode: 'auto' }, security: 'none' }
    }],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }]
  }, null, 2));

  spawn(XRAY, ['-c', CONF], { cwd: DIR, stdio: 'inherit' })
    .on('exit', c => { console.log('[xray] 退出 ' + c); setTimeout(main, 3000); });

  spawn(CF, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${PORT}`, 'run', '--token', TOKEN], { cwd: DIR, stdio: 'inherit' })
    .on('exit', c => { console.log('[cloudflared] 退出 ' + c); process.exit(1); });

  console.log('[*] 节点信息 >>>>>>>>>>>>>>>> ');
  console.log('端口: ' + PORT + '\nUUID: ' + uuid + '\n节点: ' + link());
  console.log('[*] >>>>>>>>>>>>>>>>>>>>>>>> ');
}

main().catch(e => { console.error(e); process.exit(1); });
```

部署要点：

- 环境变量 `ARGO_TOKEN` 必填（Zero Trust 里已建好的隧道 token）；`ARGO_PORT` 默认 8080；`ARGO_DOMAIN` 可选，填了就直接打印完整可用链接。
- Cloudflare 后台该隧道的 Public Hostname 必须指向 `http://localhost:8080`（或你改的端口），Service 类型选 HTTP。
- 启动命令 `npm start`，主机需允许写入 `.npm` 与外网访问 GitHub。
- 客户端：XHTTP + TLS，`mode=auto`、`path=/`、`sni`/`host` 均为你的域名，SNI 与 Host 必须一致否则 403。

注意事项：`127.0.0.1` 绑定意味着容器外无法直连 8080，全部流量只走隧道，安全但也要求 Cloudflare 侧配置正确；如果主机用 IPv6-only 或 docker 网络特殊，把监听改成 `0.0.0.0` 即可。
