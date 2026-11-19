#!/usr/bin/env node
'use strict';
// 依赖 Node >= 18（内置 fetch）。仅支持 linux amd64 / arm64
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const DIR = path.join(__dirname, '.npm');
const STATE = path.join(DIR, 'state.json');
const LINKS = path.join(DIR, 'links.txt');
const CONF = path.join(DIR, 'config.yaml');
const SHOES_BIN = path.join(DIR, 'shoes');
const CF_BIN = path.join(DIR, 'cloudflared');

const SHOW_LOG = /^true$/i.test(process.env.SHOW_LOG || '');
const PORT = parseInt(process.env.ARGO_PORT || '8080', 10);
const TOKEN = (process.env.ARGO_TOKEN || '').trim();
const DOMAIN = (process.env.ARGO_DOMAIN || '').trim();

const ARCH = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
if (process.platform !== 'linux' || !ARCH) {
  console.error(`仅支持 linux amd64 / arm64，当前 ${process.platform}/${process.arch}`);
  process.exit(1);
}
const TRIPLE = ARCH === 'amd64' ? 'x86_64' : 'aarch64';
const log = (...a) => SHOW_LOG && console.log(...a);

const children = [];
const killAll = () => children.forEach((c) => { try { c.kill('SIGKILL'); } catch {} });
process.on('exit', killAll);
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { killAll(); process.exit(0); }));

const exists = (p) => fsp.access(p).then(() => true, () => false);

// 流式下载，不缓冲进内存，避免 OOM
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${c}`))));
  });
}

async function findFile(dir, name, depth = 3) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory() && depth > 0) {
      const r = await findFile(p, name, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

async function ensure() {
  await fsp.mkdir(DIR, { recursive: true });

  if (!(await exists(SHOES_BIN))) {
    const tgz = path.join(DIR, 'shoes.tar.gz');
    const tmp = path.join(DIR, '.tmp');
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.mkdir(tmp, { recursive: true });
    await download(
      `https://github.com/cfal/shoes/releases/download/v0.3.8/shoes-${TRIPLE}-unknown-linux-musl.tar.gz`,
      tgz
    );
    await run('tar', ['-xzf', tgz, '-C', tmp]);
    const found = await findFile(tmp, 'shoes');
    if (!found) throw new Error('压缩包内未找到 shoes 二进制');
    await fsp.rename(found, SHOES_BIN);
    await fsp.chmod(SHOES_BIN, 0o755);
    await fsp.rm(tgz, { force: true });
    await fsp.rm(tmp, { recursive: true, force: true });
    console.log('[+] shoes 就绪');
  }

  if (!(await exists(CF_BIN))) {
    await download(
      `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`,
      CF_BIN
    );
    await fsp.chmod(CF_BIN, 0o755);
    console.log('[+] cloudflared 就绪');
  }
}

async function loadState() {
  let s = {};
  try { s = JSON.parse(await fsp.readFile(STATE, 'utf8')); } catch {}
  if (!s.uuid) s.uuid = crypto.randomUUID();
  if (!s.path) s.path = '/' + crypto.randomBytes(8).toString('hex');
  await fsp.writeFile(STATE, JSON.stringify(s, null, 2));
  return s;
}

const config = (s) => `- address: 127.0.0.1:${PORT}
  protocol:
    type: ${TOKEN ? 'xhttp' : 'ws'}
    targets:
      - matching_path: ${s.path}
        protocol:
          type: vless
          user_id: ${s.uuid}
          udp_enabled: true
`;

function link(s, host) {
  const q = [
    'encryption=none',
    'security=tls',
    `sni=${host}`,
    'fp=chrome',
    `type=${TOKEN ? 'xhttp' : 'ws'}`,
    `host=${host}`,
    `path=${encodeURIComponent(s.path)}`,
  ];
  if (TOKEN) q.push('mode=auto');
  const name = `${TOKEN ? 'argo-xhttp' : 'argo-ws'}-${host}`;
  return `vless://${s.uuid}@${host}:443?${q.join('&')}#${name}`;
}

async function publish(s, host) {
  const url = link(s, host);
  await fsp.writeFile(LINKS, url + '\n');
  console.log('\n' + url + '\n');
}

async function startCF(s) {
  const args = TOKEN
    ? ['tunnel', '--no-autoupdate', 'run', '--token', TOKEN]
    : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`];

  const p = spawn(CF_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);

  let resolved = !!TOKEN;
  const onData = (buf) => {
    const t = buf.toString();
    log('[cfd]', t.trimEnd());
    if (resolved) return;
    const m = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m) {
      resolved = true;
      publish(s, m[0].replace(/^https:\/\//, '')).catch(console.error);
    }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('exit', (c) => {
    if (!resolved) {
      console.error('[x] cloudflared 退出', c);
      process.exit(1);
    }
  });
}

(async () => {
  await ensure();
  const s = await loadState();
  await fsp.writeFile(CONF, config(s));

  const shoes = spawn(SHOES_BIN, [CONF], {
    stdio: SHOW_LOG ? ['ignore', 'inherit', 'inherit'] : 'ignore',
  });
  children.push(shoes);
  shoes.on('exit', (c) => {
    console.error('[x] shoes 退出', c);
    process.exit(1);
  });

  if (TOKEN) {
    if (!DOMAIN) console.error('[!] 已设置 ARGO_TOKEN 但缺少 ARGO_DOMAIN，链接里的域名请自行替换');
    await publish(s, DOMAIN || 'your-domain.com');
  }

  await new Promise((r) => setTimeout(r, 1500)); // 等 shoes 监听
  await startCF(s);
})().catch((e) => {
  console.error('[x]', e.message);
  process.exit(1);
});