const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const DIR = path.join(__dirname, '.npm');
const BIN = path.join(DIR, 'sing-box');
const CFG = path.join(DIR, 'config.json');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const INFO = path.join(DIR, 'nodes.txt');
const LOG = path.join(DIR, 'sing-box.log');
const STATE = path.join(DIR, 'state.json');
const VERSION = '1.11.4';
const ARCH = ({ x64: 'amd64', arm64: 'arm64', arm: 'armv7' })[process.arch] || 'amd64';

const HY2_PORT = process.env.HY2_PORT;
const TUIC_PORT = process.env.TUIC_PORT;

const sh = (cmd) => execSync(cmd, { cwd: DIR, stdio: 'pipe' }).toString().trim();
const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); });
});
const isPort = (v) => (v && Number(v) > 0 ? Number(v) : 0);

/* ---------- 0. 凭据: 环境变量 > state.json > 随机 ---------- */
function loadState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch {}
  const next = {
    pass: process.env.PASSWORD || s.pass || crypto.randomBytes(12).toString('base64url'),
    uuid: process.env.UUID || s.uuid || crypto.randomUUID(),
  };
  if (next.pass !== s.pass || next.uuid !== s.uuid) {
    fs.writeFileSync(STATE, JSON.stringify(next, null, 2), { mode: 0o600 });
  }
  return next;
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const { pass: PASS, uuid: UUID } = loadState();

  /* ---------- 1. 下载并解压 sing-box ---------- */
  if (!fs.existsSync(BIN)) {
    const pkg = `sing-box-${VERSION}-linux-${ARCH}`;
    sh(`curl -fsSL -o sb.tar.gz https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${pkg}.tar.gz`);
    sh(`tar -xzf sb.tar.gz`);
    fs.copyFileSync(path.join(DIR, pkg, 'sing-box'), BIN);
    fs.rmSync(path.join(DIR, pkg), { recursive: true, force: true });
    fs.rmSync(path.join(DIR, 'sb.tar.gz'), { force: true });
    fs.chmodSync(BIN, 0o755);
  }

  /* ---------- 2. 自签证书 + SHA-256 指纹 ---------- */
  if (!fs.existsSync(CERT) || !fs.existsSync(KEY)) {
    sh('openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 ' +
       '-subj "/CN=www.bing.com" -keyout key.pem -out cert.pem 2>/dev/null');
  }
  const FP = sh('openssl x509 -in cert.pem -noout -fingerprint -sha256')
    .split('=')[1].trim().toUpperCase();

  /* ---------- 3. 端口 / 地址 ---------- */
  let hy2Port = isPort(HY2_PORT);
  let tuicPort = isPort(TUIC_PORT);
  if (!hy2Port && !tuicPort) hy2Port = await freePort();
  if (hy2Port && tuicPort && hy2Port === tuicPort) {
    console.error(`端口冲突: HY2_PORT 与 TUIC_PORT 不能相同 (${hy2Port})`);
    process.exit(1);
  }

  let host = process.env.HOST || '';
  if (!host) {
    try { host = sh('curl -fsS --max-time 8 https://api.ipify.org'); } catch { host = '127.0.0.1'; }
  }
  const sni = process.env.SNI || (net.isIP(host) ? 'www.bing.com' : host);
  const name = host.replace(/[.:]/g, '-');

  /* ---------- 4. 生成配置 ---------- */
  const tls = { enabled: true, certificate_path: CERT, key_path: KEY, alpn: ['h3'] };
  const cfg = { log: { level: 'info', timestamp: true }, inbounds: [], outbounds: [{ type: 'direct', tag: 'direct' }] };

  if (hy2Port) cfg.inbounds.push({
    type: 'hysteria2', tag: 'hy2', listen: '::', listen_port: hy2Port,
    users: [{ password: PASS }], tls,
  });
  if (tuicPort) cfg.inbounds.push({
    type: 'tuic', tag: 'tuic', listen: '::', listen_port: tuicPort,
    users: [{ uuid: UUID, password: PASS }], congestion_control: 'bbr', tls,
  });

  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
  sh(`./sing-box check -c ${CFG}`);

  /* ---------- 5. 节点链接 ---------- */
  const links = [];
  if (hy2Port) links.push(
    `hysteria2://${encodeURIComponent(PASS)}@${host}:${hy2Port}/?sni=${sni}&insecure=1&pinSHA256=${FP}#hy2-${name}`
  );
  if (tuicPort) links.push(
    `tuic://${UUID}:${encodeURIComponent(PASS)}@${host}:${tuicPort}?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=${sni}&allow_insecure=1&pinSHA256=${FP}#tuic-${name}`
  );

  const report = [
    `# sing-box ${VERSION}`,
    `密码: ${PASS}`,
    tuicPort ? `TUIC UUID: ${UUID}` : '',
    `SHA-256: ${FP}`,
    '', ...links, '',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(INFO, report, { mode: 0o600 });

  /* ---------- 6. 重启并启动 ---------- */
  try { execSync('pkill -f ".npm/sing-box run"'); } catch {}
  await new Promise((r) => setTimeout(r, 400));

  const out = fs.openSync(LOG, 'a');
  const proc = spawn(BIN, ['run', '-c', CFG], { cwd: DIR, detached: true, stdio: ['ignore', out, out] });
  proc.unref();

  await new Promise((r) => setTimeout(r, 1200));
  if (proc.exitCode !== null) {
    console.error('启动失败，日志:\n' + fs.readFileSync(LOG, 'utf8').split('\n').slice(-15).join('\n'));
    process.exit(1);
  }

  console.log(report);
  console.log(`节点文件: ${INFO}\n日志: ${LOG}\n状态: ${STATE}`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
