// index.js
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DIR = path.join(process.cwd(), '.npm');
fs.mkdirSync(DIR, { recursive: true });

const PORT = process.env.ARGO_PORT || '8080';
const TOKEN = (process.env.ARGO_TOKEN || '').trim();
const DOMAIN = (process.env.ARGO_DOMAIN || '').trim();
const WSPATH = '/vless';
const ARCH = os.arch() === 'arm64' ? 'arm64' : 'amd64';

const SB = path.join(DIR, 'sing-box');
const CF = path.join(DIR, 'cloudflared');
const CFG = path.join(DIR, 'config.json');
const UUID_FILE = path.join(DIR, 'uuid');

let uuid = fs.existsSync(UUID_FILE) ? fs.readFileSync(UUID_FILE, 'utf8').trim() : '';
if (!uuid) { uuid = crypto.randomUUID(); fs.writeFileSync(UUID_FILE, uuid); }

async function dl(url, dest) {
  let u = url;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(u, { redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) { u = new URL(r.headers.get('location'), u).href; continue; }
    if (!r.ok) throw new Error(`${r.status} ${u}`);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return;
  }
  throw new Error('too many redirects');
}

async function setup() {
  if (!fs.existsSync(SB)) {
    const tgz = path.join(DIR, 'sb.tgz');
    await dl(`https://github.com/SagerNet/sing-box/releases/download/v1.11.4/sing-box-1.11.4-linux-${ARCH}.tar.gz`, tgz);
    execSync(`tar -xzf "${tgz}" -C "${DIR}" --strip-components=1`, { stdio: 'inherit' });
    fs.rmSync(tgz, { force: true });
  }
  if (!fs.existsSync(CF)) {
    await dl(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`, CF);
  }
  fs.chmodSync(SB, 0o755);
  fs.chmodSync(CF, 0o755);
}

function writeConfig() {
  fs.writeFileSync(CFG, JSON.stringify({
    log: { level: 'warn', timestamp: true },
    inbounds: [{
      type: 'vless',
      tag: 'vless-ws',
      listen: '0.0.0.0',
      listen_port: Number(PORT),
      users: [{ uuid }],
      transport: { type: 'ws', path: WSPATH }
    }],
    outbounds: [{ type: 'direct', tag: 'direct' }]
  }, null, 2));
}

function link(host) {
  const h = host || DOMAIN || '<your-domain>';
  return `vless://${uuid}@${h}:443?encryption=none&security=tls&sni=${h}&fp=random&type=ws&host=${h}&path=${encodeURIComponent(WSPATH)}#argo-ws`;
}

async function main() {
  await setup();
  writeConfig();

  const sb = spawn(SB, ['run', '-c', CFG], { stdio: 'inherit' });
  sb.on('exit', c => { console.log('sing-box exited', c); process.exit(c ?? 1); });

  const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`];
  if (TOKEN) args.push('run', '--token', TOKEN);
  const cf = spawn(CF, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let done = false;
  const onData = d => {
    const s = d.toString();
    process.stdout.write(s);
    if (done) return;
    const m = s.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
    if (m) {
      done = true;
      console.log('\n=== 节点 ===\n' + link(m[1]) + '\n');
    }
  };
  cf.stdout.on('data', onData);
  cf.stderr.on('data', onData);
  cf.on('exit', c => { console.log('cloudflared exited', c); process.exit(c ?? 1); });

  if (TOKEN) {
    setTimeout(() => {
      if (done) return;
      done = true;
      if (!DOMAIN) console.log('\n固定隧道已启动，但未设置 ARGO_DOMAIN，请到 Cloudflare 后台绑定主机名后自行拼接链接。');
      else console.log('\n=== 节点 ===\n' + link(DOMAIN) + '\n');
    }, 8000);
  }

  const stop = () => { try { cf.kill(); } catch {} try { sb.kill(); } catch {} process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(e => { console.error(e); process.exit(1); });
