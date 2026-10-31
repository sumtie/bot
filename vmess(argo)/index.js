// index.js  ——  node index.js
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const BASE = path.join(process.cwd(), '.npm');

const PORT = parseInt(process.env.ARGO_PORT || '8080', 10);
const TOKEN = (process.env.ARGO_TOKEN || '').trim();
const DOMAIN = (process.env.ARGO_DOMAIN || '').trim();

const WS_PATH = '/argo';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';
const SB = path.join(BASE, 'sing-box');
const CF = path.join(BASE, 'cloudflared');
const CFG = path.join(BASE, 'config.json');
const UUID_F = path.join(BASE, 'uuid.txt');


function uuid() {
  if (fs.existsSync(UUID_F)) {
    const v = fs.readFileSync(UUID_F, 'utf8').trim();
    if (v) return v;
  }
  const v = crypto.randomUUID();
  fs.writeFileSync(UUID_F, v);
  return v;
}

async function dl(url, dest) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
}

async function prepare() {
  if (!fs.existsSync(SB)) {
    const tgz = path.join(BASE, 'sb.tgz');
    await dl(`https://github.com/SagerNet/sing-box/releases/download/v1.11.4/sing-box-1.11.4-linux-${ARCH}.tar.gz`, tgz);
    execSync(`tar -xzf "${tgz}" -C "${BASE}" --strip-components=1`);
    fs.rmSync(tgz, { force: true });
    fs.chmodSync(SB, 0o755);
  }
  if (!fs.existsSync(CF)) {
    await dl(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`, CF);
    fs.chmodSync(CF, 0o755);
  }
}

function writeConfig(id) {
  fs.writeFileSync(CFG, JSON.stringify({
    log: { level: 'warn', timestamp: true },
    inbounds: [{
      type: 'vmess',
      tag: 'vmess-ws',
      listen: '127.0.0.1',
      listen_port: PORT,
      users: [{ uuid: id, alterId: 0 }],
      transport: {
        type: 'ws',
        path: WS_PATH,
        max_early_data: 2048,
        early_data_header_name: 'Sec-WebSocket-Protocol'
      }
    }],
    outbounds: [{ type: 'direct', tag: 'direct' }]
  }, null, 2));
}

function show(id, host) {
  const j = {
    v: '2', ps: 'argo-vmess', add: host, port: '443', id, aid: '0',
    scy: 'auto', net: 'ws', type: 'none', host,
    path: `${WS_PATH}?ed=2048`, tls: 'tls', sni: host, alpn: '', fp: ''
  };
  console.log('\n============ 节点信息 ============');
  console.log(`地址: ${host}`);
  console.log(`端口: 443  TLS: tls  path: ${WS_PATH}?ed=2048`);
  console.log(`UUID: ${id}`);
  console.log('vmess://' + Buffer.from(JSON.stringify(j)).toString('base64'));
  console.log('==================================\n');
}

let sb, cf, stopping = false;

function startSingBox() {
  sb = spawn(SB, ['run', '-c', CFG], { stdio: ['ignore', 'inherit', 'inherit'] });
  sb.on('exit', c => { if (!stopping) { console.log('[sing-box] 退出', c, '重启'); setTimeout(startSingBox, 3000); } });
}

function startTunnel(id) {
  if (TOKEN) {
    console.log('[argo] 固定隧道启动');
    cf = spawn(CF, ['tunnel', '--no-autoupdate', '--edge-ip-version', 'auto', 'run', '--token', TOKEN], { stdio: ['ignore', 'pipe', 'pipe'] });
    cf.stdout.pipe(process.stdout); cf.stderr.pipe(process.stderr);
    if (DOMAIN) show(id, DOMAIN);
    else console.log(`固定隧道已启动，未填 ARGO_DOMAIN；请把 CF 后台 ingress 指向 http://127.0.0.1:${PORT}`);
  } else {
    let done = false;
    cf = spawn(CF, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = d => {
      const s = d.toString();
      process.stdout.write(s);
      const m = !done && s.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
      if (m) { done = true; show(id, m[1]); }
    };
    cf.stdout.on('data', onData); cf.stderr.on('data', onData);
    setTimeout(() => { if (!done) console.log('[argo] 30s 未取到临时域名，检查出网'); }, 30000);
  }
  cf.on('exit', c => { if (!stopping) { console.log('[argo] 退出', c, '重启'); setTimeout(() => startTunnel(id), 5000); } });
}

(async () => {
  await prepare();
  const id = uuid();
  writeConfig(id);
  startSingBox();
  await new Promise(r => setTimeout(r, 1500));
  startTunnel(id);
})();

['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => {
  stopping = true;
  try { sb?.kill(); } catch {}
  try { cf?.kill(); } catch {}
  process.exit(0);
}));