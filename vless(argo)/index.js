const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DIR = path.join(process.cwd(), '.npm');
fs.mkdirSync(DIR, { recursive: true });

// 有填写隧道token就使用固定隧道，没有就临时隧道
const PORT = process.env.ARGO_PORT || '8080';
const TOKEN = (process.env.ARGO_TOKEN || '').trim();
const DOMAIN = (process.env.ARGO_DOMAIN || '').trim();
const WSPATH = '/vless';
const ARCH = os.arch() === 'arm64' ? 'arm64' : 'amd64';

// HY2_PORT 把 0 改成容器/平台开放的公网端口，就可以启用hysteria2节点了。
const HY2_PORT = Number((process.env.HY2_PORT || '0').trim());
const HY2_ON = Number.isInteger(HY2_PORT) && HY2_PORT > 0 && HY2_PORT < 65536;
const HY2_HOST = (process.env.HY2_HOST || '').trim();
const HY2_SNI = 'bing.com';

const SB = path.join(DIR, 'sing-box');
const CF = path.join(DIR, 'cloudflared');
const CFG = path.join(DIR, 'config.json');
const UUID_FILE = path.join(DIR, 'uuid');
const CERT_FILE = path.join(DIR, 'hy2.crt');
const KEY_FILE = path.join(DIR, 'hy2.key');
const FP_FILE = path.join(DIR, 'hy2.fp');

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
    console.log('[*] 拉取 sing-box ');
    const tgz = path.join(DIR, 'sb.tgz');
    await dl(`https://github.com/SagerNet/sing-box/releases/download/v1.11.4/sing-box-1.11.4-linux-${ARCH}.tar.gz`, tgz);
    execSync(`tar -xzf "${tgz}" -C "${DIR}" --strip-components=1`, { stdio: 'inherit' });
    fs.rmSync(tgz, { force: true });
  }
  if (!fs.existsSync(CF)) {
    console.log('[*] 拉取 cloudflared ');
    await dl(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`, CF);
  }
  fs.chmodSync(SB, 0o755);
  fs.chmodSync(CF, 0o755);
}

/* ---------- DER 编码基础 ---------- */

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  let v = n;
  while (v > 0) { b.unshift(v & 0xff); v >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}
function seq(...items) { return tlv(0x30, Buffer.concat(items)); }
function set(...items) { return tlv(0x31, Buffer.concat(items)); }
function oid(dotted) {
  const p = dotted.split('.').map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) {
    const stack = [n & 0x7f];
    let v = n >> 7;
    while (v) { stack.unshift((v & 0x7f) | 0x80); v >>= 7; }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
function integer(buf) {
  let b = buf;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function utf8(s) { return tlv(0x0c, Buffer.from(s, 'utf8')); }
function bits(buf, unused = 0) { return tlv(0x03, Buffer.concat([Buffer.from([unused]), buf])); }
function explicit(n, content) { return tlv(0xa0 + n, content); }
function name(cn) { return seq(set(seq(oid('2.5.4.3'), utf8(cn)))); }
function utcTime(d) { return tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z')); }

/* ---------- 自签证书（纯 Node，无外部依赖） ---------- */

function fingerprint(der) {
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');
}

function ensureCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE) && fs.existsSync(FP_FILE)) {
    try {
      const c = new crypto.X509Certificate(fs.readFileSync(CERT_FILE));
      if ((c.subjectAltName || '').includes(`DNS:${HY2_SNI}`)) return fingerprint(c.raw);
    } catch {}
    console.log('[*] 旧证书无效，重新生成');
  } else {
    console.log('[*] 生成自签证书');
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const sigAlg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const now = Date.now();

  const exts = [
    seq(oid('2.5.29.19'), Buffer.from([0x01, 0x01, 0xff]), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))), // basicConstraints CA:TRUE
    seq(oid('2.5.29.15'), Buffer.from([0x01, 0x01, 0xff]), tlv(0x04, bits(Buffer.from([0x80]), 7))),        // keyUsage digitalSignature
    seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0x82, Buffer.from(HY2_SNI))))),                                // SAN dNSName
    seq(oid('2.5.29.37'), tlv(0x04, seq(oid('1.3.6.1.5.5.7.3.1')))),                                       // EKU serverAuth
    seq(oid('2.5.29.14'), tlv(0x04, tlv(0x04, crypto.createHash('sha1').update(spki).digest())))           // SKI
  ];

  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(crypto.randomBytes(16)),
    sigAlg,
    name(HY2_SNI),
    seq(utcTime(new Date(now - 86400000)), utcTime(new Date(now + 3650 * 86400000))),
    name(HY2_SNI),
    spki,
    explicit(3, seq(...exts))
  );

  const cert = seq(tbs, sigAlg, bits(crypto.sign('sha256', tbs, privateKey)));
  const fp = fingerprint(cert);

  fs.writeFileSync(CERT_FILE, `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`);
  fs.writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(FP_FILE, fp);
  return fp;
}

/* ---------- 配置 ---------- */

function writeConfig() {
  const inbounds = [{
    type: 'vless',
    tag: 'vless-ws',
    listen: '0.0.0.0',
    listen_port: Number(PORT),
    users: [{ uuid }],
    transport: { type: 'ws', path: WSPATH }
  }];

  if (HY2_ON) {
    inbounds.push({
      type: 'hysteria2',
      tag: 'hy2',
      listen: '0.0.0.0',
      listen_port: HY2_PORT,
      users: [{ password: uuid }],
      tls: {
        enabled: true,
        server_name: HY2_SNI,
        alpn: ['h3'],
        certificate_path: CERT_FILE,
        key_path: KEY_FILE
      }
    });
  }

  fs.writeFileSync(CFG, JSON.stringify({
    log: { level: 'warn', timestamp: true },
    inbounds,
    outbounds: [{ type: 'direct', tag: 'direct' }]
  }, null, 2));
}

/* ---------- 链接 ---------- */

function link(host) {
  const h = host || DOMAIN || '<your-domain>';
  return `vless://${uuid}@${h}:443?encryption=none&security=tls&sni=${h}&fp=random&type=ws&host=${h}&path=${encodeURIComponent(WSPATH)}#argo-ws`;
}

function hy2Link(host, fp) {
  const h = HY2_HOST || host || DOMAIN || '<your-ip>';
  return `hysteria2://${uuid}@${h}:${HY2_PORT}?sni=${HY2_SNI}&insecure=1&pinSHA256=${fp}#hy2`;
}

// function printNodes(host, fp) {
//   console.log('\n=== 节点 ===\n' + link(host) + '\n');
//   if (!HY2_ON) return;
//   console.log(hy2Link(host, fp) + '\n');
//   console.log(`证书指纹: ${fp}`);
//   if (!HY2_HOST) console.log('提示: Hysteria2 走 UDP 直连，Cloudflare 域名不通 UDP，请设置 HY2_HOST 为公网 IP 或直连域名后重新生成链接。\n');
// }
function printNodes(host, fp) {
  const C = {
    reset: '\x1b[0m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    gray: '\x1b[90m',
    bold: '\x1b[1m',
    white: '\x1b[37m'
  };

  const line = `${C.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`;
  const title = (s) => console.log(`\n${C.bold}${C.cyan}  ${s}${C.reset}`);
  const item = (k, v) => console.log(
    `  ${C.gray}${k.padEnd(12)}${C.reset}: ${C.white}${v}${C.reset}`
  );

  const vless = link(host);
  const h = host || DOMAIN || '<your-domain>';

  console.log('\n');
  console.log(`${C.green}${C.bold}       ✓ 服务启动成功${C.reset}`);
  console.log(line);

  // VLESS 节点
  title('VLESS + WebSocket + TLS');

  item('节点名称', 'argo-ws');
  item('服务器', h);
  item('端口', '443');
  item('UUID', uuid);
  item('传输协议', 'WebSocket');
  item('WS Path', WSPATH);
  item('TLS', 'Enabled');
  item('SNI', h);
  item('指纹', 'random');

  console.log(line);
  console.log(`${C.yellow}  [VLESS 分享链接]${C.reset}`);
  console.log(`${C.green}${vless}${C.reset}`);

  // Hysteria2 节点
  if (HY2_ON) {
    const hy2 = hy2Link(host, fp);
    const hy2Host = HY2_HOST || host || DOMAIN || '<your-ip>';

    console.log(line);
    title('Hysteria2 + TLS');

    item('节点名称', 'hy2');
    item('服务器', hy2Host);
    item('端口', HY2_PORT);
    item('协议', 'UDP');
    item('认证密码', uuid);
    item('TLS SNI', HY2_SNI);
    item('ALPN', 'h3');
    item('证书验证', 'SHA256 Pin');
    item('证书指纹', fp);

    console.log(line);
    console.log(`${C.yellow}  [Hysteria2 分享链接]${C.reset}`);
    console.log(`${C.green}${hy2}${C.reset}`);

    if (!HY2_HOST) {
      console.log(
        `\n${C.yellow}  ! 提示：HY2 使用 UDP，不能直接通过 Cloudflare 普通代理转发。${C.reset}`
      );
      console.log(
        `${C.gray}  建议设置 HY2_HOST 为公网 IP 或支持 UDP 的直连域名。${C.reset}`
      );
    }
  }

  console.log(line);
  console.log(`${C.green}  ✓ 节点信息输出完成${C.reset}`);
  console.log(`${C.gray}  UUID 文件: ${UUID_FILE}${C.reset}`);
  console.log(`${C.gray}  配置文件: ${CFG}${C.reset}`);
  console.log(line);
  console.log('');
}



async function main() {
  await setup();
  const fp = HY2_ON ? ensureCert() : '';
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
      printNodes(m[1], fp);
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
      else printNodes(DOMAIN, fp);
    }, 8000);
  }

  const stop = () => { try { cf.kill(); } catch {} try { sb.kill(); } catch {} process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(e => { console.error(e); process.exit(1); });
