#!/usr/bin/env node
'use strict';
// 依赖: node >= 18 (global fetch), openssl, linux amd64/arm64
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const D = path.join(__dirname, '.npm');
const STATE = path.join(D, 'state.json');
const CFG = path.join(D, 'config.json');
const LINKS = path.join(D, 'links.txt');
const CERT = path.join(D, 'cert.pem');
const KEY = path.join(D, 'key.pem');
const XRAY = path.join(D, 'xray');
const ARGO = path.join(D, 'cloudflared');

const SHOW_LOG = String(process.env.SHOW_LOG).toLowerCase() === 'true';
const HY2_PORT = Number(process.env.HY2_PORT || 0);
const ARGO_PORT = Number(process.env.ARGO_PORT || 8080);
const ARGO_TOKEN = process.env.ARGO_TOKEN || '';
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const UP = 120;   // 服务端上行 mbps
const DOWN = 100; // 服务端下行 mbps
const SNI = 'www.bing.com';

// 内存: 两个 Go 进程合计软上限 ~MB, 留出运行时余量
const MEM_XRAY = 64, MEM_ARGO = 48, GOGC = '50';

const ARCH = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!ARCH) { console.error(`不支持的架构: ${process.arch}`); process.exit(1); }

const kids = [];
let stopping = false;

// 流式下载: 不把整个二进制读进内存
async function dl(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
  const name = path.basename(dest);
  const tmp = dest + '.tmp';
  console.log(`下载 ${name} ...`);

  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`下载失败 ${r.status}: ${url}`);

  const total = Number(r.headers.get('content-length') || 0);
  let got = 0, last = 0;
  const body = Readable.fromWeb(r.body);
  body.on('data', (c) => {
    got += c.length;
    const now = Date.now();
    if (total && now - last > 200) {
      last = now;
      process.stdout.write(`\r  ${name} ${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB`);
    }
  });

  try {
    await pipeline(body, fs.createWriteStream(tmp, { mode: 0o755 }));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  if (!got) { try { fs.unlinkSync(tmp); } catch {} throw new Error(`${name} 下载为空`); }
  if (total && got !== total) { try { fs.unlinkSync(tmp); } catch {} throw new Error(`${name} 下载不完整 ${got}/${total}`); }
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o755);
  if (total) process.stdout.write('\n');
}

async function getIP() {
  if (process.env.IP) return process.env.IP;
  for (const u of ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://ip.sb']) {
    try {
      const t = (await (await fetch(u)).text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t;
    } catch {}
  }
  return '';
}

function supervise(name, fn) {
  const start = () => {
    const p = fn();
    kids.push(p);
    p.on('exit', (c) => { if (!stopping) { console.log(`${name} 退出(${c})，3s 后重启`); setTimeout(start, 3000); } });
    return p;
  };
  return start();
}

(async () => {
  fs.mkdirSync(D, { recursive: true });

  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  const rnd = (n) => crypto.randomBytes(n).toString('hex');
  state.password ||= rnd(16);
  state.uuid ||= crypto.randomUUID();
  state.xhttpPath ||= '/' + rnd(8);
  state.wsPath ||= '/' + rnd(8);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });

  await Promise.all([
    dl(`https://github.com/sumtie/files/releases/download/261109/mybot-linux-${ARCH}`, XRAY),
    dl(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`, ARGO),
  ]);

  let pin = '';
  if (HY2_PORT) {
    if (!fs.existsSync(CERT) || !fs.existsSync(KEY)) {
      const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec',
        '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-keyout', KEY, '-out', CERT,
        '-days', '3650', '-nodes', '-subj', `/CN=${SNI}`,
        '-addext', `subjectAltName=DNS:${SNI}`], { stdio: 'ignore' });
      if (r.status !== 0) { console.error('证书生成失败'); process.exit(1); }
      fs.chmodSync(KEY, 0o600);
    }
    const out = spawnSync('openssl', ['x509', '-in', CERT, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' }).stdout || '';
    pin = (out.match(/=([0-9A-F:]{95})/i) || [])[1] || '';
    if (!pin) console.warn('警告: 未能计算证书指纹');
  }

  const inbounds = [{
    tag: 'argo',
    listen: '127.0.0.1',
    port: ARGO_PORT,
    protocol: 'vless',
    settings: { clients: [{ id: state.uuid }], decryption: 'none' },
    streamSettings: ARGO_TOKEN
      ? { network: 'xhttp', security: 'none', xhttpSettings: { path: state.xhttpPath, mode: 'auto' } }
      : { network: 'ws', security: 'none', wsSettings: { path: state.wsPath } },
  }];

  if (HY2_PORT) {
    inbounds.push({
      tag: 'hy2',
      listen: '0.0.0.0',
      port: HY2_PORT,
      protocol: 'hysteria',
      settings: { version: 2, users: [{ auth: state.password, email: 'hy2' }] },
      streamSettings: {
        network: 'hysteria',
        security: 'tls',
        tlsSettings: { serverName: SNI, alpn: ['h3'], certificates: [{ usage: 'encipherment', certificateFile: CERT, keyFile: KEY }] },
        hysteriaSettings: { version: 2, auth: state.password },
        finalmask: { quicParams: { congestion: 'brutal', brutalUp: `${UP} mbps`, brutalDown: `${DOWN} mbps` } },
      },
    });
  }

  fs.writeFileSync(CFG, JSON.stringify({
    log: { loglevel: 'warning' },
    inbounds,
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
  }, null, 2), { mode: 0o600 });

  const test = spawnSync(XRAY, ['run', '-test', '-c', CFG], { encoding: 'utf8', cwd: D });
  if (test.status !== 0) { console.error('配置校验失败:\n' + (test.stderr || test.stdout)); process.exit(1); }

  supervise('xray', () => {
    const p = spawn(XRAY, ['run', '-c', CFG], {
      cwd: D, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GOMEMLIMIT: `${MEM_XRAY}MiB`, GOGC, GODEBUG: 'madvdontneed=1' },
    });
    const out = (d) => { if (SHOW_LOG) process.stdout.write(d); };
    p.stdout.on('data', out);
    p.stderr.on('data', out);
    return p;
  });

  const argoArgs = ARGO_TOKEN
    ? ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', ARGO_TOKEN]
    : ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${ARGO_PORT}`];

  supervise('cloudflared', () => {
    const p = spawn(ARGO, argoArgs, {
      cwd: D, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GOMEMLIMIT: `${MEM_ARGO}MiB`, GOGC, GODEBUG: 'madvdontneed=1' },
    });
    const out = (d) => {
      if (SHOW_LOG) process.stdout.write(d);
      if (!ARGO_TOKEN && !ARGO_DOMAIN) {
        const m = String(d).match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
        if (m) emit(m[1]);
      }
    };
    p.stdout.on('data', out);
    p.stderr.on('data', out);
    return p;
  });

  let emitted = false;
  async function emit(tempHost) {
    if (emitted) return;
    const host = ARGO_DOMAIN || tempHost;
    if (!host) { console.warn('缺少 ARGO_DOMAIN，跳过 argo 链接'); return; }
    emitted = true;

    const lines = [];
    const q = (o) => new URLSearchParams(o).toString();
    const vless = (type, p) => `vless://${state.uuid}@${host}:443?` + q({
      encryption: 'none', security: 'tls', sni: host, fp: 'chrome',
      type, host, path: p, ...(type === 'xhttp' ? { mode: 'auto' } : {}),
    }) + `#${type}`;
    lines.push(vless(ARGO_TOKEN ? 'xhttp' : 'ws', ARGO_TOKEN ? state.xhttpPath : state.wsPath));

    if (HY2_PORT) {
      const ip = await getIP();
      if (ip) {
        lines.push(`hysteria2://${state.password}@${ip}:${HY2_PORT}/?` + q({
          sni: SNI, insecure: 1, ...(pin ? { pinSHA256: pin } : {}),
          alpn: 'h3', upmbps: DOWN, downmbps: UP,
        }) + `#hy2-${HY2_PORT}`);
      }
    }

    const text = lines.join('\n') + '\n';
    fs.writeFileSync(LINKS, text, { mode: 0o600 });
    console.log('\n===== 节点链接 =====\n' + text);
  }

  if (ARGO_TOKEN) setTimeout(() => emit(''), 3000);

  const stop = () => {
    stopping = true;
    kids.forEach((p) => { try { p.kill('SIGKILL'); } catch {} });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => { console.error(e); process.exit(1); });