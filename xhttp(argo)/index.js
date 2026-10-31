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