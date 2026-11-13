
编写nodejs代码index.js，curl下载sing-box 1.11.4, tar解压 部署在nodejs主机上，部署hysteria2或tuic节点，端口默认都是0，HY2\_PORT填写了端口就启用hysteria2节点，TUIC\_PORT填写了端口就启用tuic节点，两个都填写的话不能同一个端口，共用密码(用户填写或自动生成)，openssl自签证书，计算证书sha-256，节点带上SHA-256，证书指纹格式要这种61:BC:FD:70:...，。index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，简洁代码。

已运行 17s · 1 步



```js
#!/usr/bin/env node
'use strict';
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
const VERSION = '1.11.4';
const ARCH = ({ x64: 'amd64', arm64: 'arm64', arm: 'armv7' })[process.arch] || 'amd64';

const sh = (cmd) => execSync(cmd, { cwd: DIR, stdio: 'pipe' }).toString().trim();
const rnd = (n) => crypto.randomBytes(n).toString('base64url');
const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); });
});
const isPort = (v) => (v && Number(v) > 0 ? Number(v) : 0);

(async () => {
  fs.mkdirSync(DIR, { recursive: true });

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

  /* ---------- 3. 端口 / 密码 / 地址 ---------- */
  let hy2Port = isPort(process.env.HY2_PORT);
  let tuicPort = isPort(process.env.TUIC_PORT);
  if (!hy2Port && !tuicPort) hy2Port = await freePort();
  if (hy2Port && tuicPort && hy2Port === tuicPort) {
    console.error(`端口冲突: HY2_PORT 与 TUIC_PORT 不能相同 (${hy2Port})`);
    process.exit(1);
  }

  const PASS = process.env.PASSWORD || rnd(12);
  const UUID = crypto.randomUUID();

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
  console.log(`节点文件: ${INFO}\n日志: ${LOG}`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
```

用法：


```bash
# 只开 hysteria2（端口随机）
node index.js

# 指定端口 / 密码
HY2_PORT=8443 PASSWORD=mysecret node index.js

# 双协议（端口必须不同）
HY2_PORT=8443 TUIC_PORT=8444 node index.js

# 自定义对外域名（有域名就填，自动用作 SNI）
HY2_PORT=8443 HOST=node.example.com node index.js
```

要点说明：

+ `HY2_PORT` / `TUIC_PORT` 为空或 `0` 即视为未填写；两个都空时默认随机端口开 hysteria2，两个都填相同端口直接报错退出。
+ 密码由 `PASSWORD` 提供，缺省时随机生成；tuic 额外生成 UUID 共用同一密码。
+ 证书用 prime256v1 自签 10 年，指纹由 `openssl x509 -fingerprint -sha256` 提取为 `61:BC:FD:70:...` 格式并写入节点链接的 `pinSHA256`。
+ 二进制、`config.json`、证书、`nodes.txt`、日志全部落在同目录 `.npm/`，`nodes.txt` 权限 600。
+ 启动前用 `sing-box check` 校验配置，旧进程会被 `pkill` 掉，日志追加到 `.npm/sing-box.log`。
