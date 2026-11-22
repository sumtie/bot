const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const selfsigned = require('selfsigned');

const hy2Port = process.env.HY2_PORT || 8443;
const argoPort = process.env.ARGO_PORT || 8080;
const argoDomain = process.env.ARGO_DOMAIN || '';
const argoToken = process.env.ARGO_TOKEN || '';
const onArgo = true; // true | false
const enableLog = false; // true | false

if (process.platform !== 'linux') {
  console.error('错误: 本脚本仅支持 Linux 系统。');
  process.exit(1);
}
const arch = os.arch();
if (arch !== 'x64' && arch !== 'arm64') {
  console.error(`错误: 不支持的架构 ${arch}，仅支持 amd64 (x64) 和 arm64。`);
  process.exit(1);
}

const npmDir = path.join(__dirname, '.npm');
fs.mkdirSync(npmDir, { recursive: true });

const stateFile = path.join(npmDir, 'state.json');
let state = {};
if (fs.existsSync(stateFile)) {
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) {}
}

const password = state.password || crypto.randomBytes(16).toString('hex');
const uuid = state.uuid || crypto.randomUUID();
const nodePath = state.xhttpPath || crypto.randomBytes(8).toString('hex');
state = { password, uuid, xhttpPath: nodePath };
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

// 启动临时隧道并解析 trycloudflare.com 域名
function startQuickTunnel(binPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${argoPort}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let done = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      if (enableLog) process.stdout.write(text);
      const match = text.match(/https:\/\/([a-zA-Z0-9-]+\.trycloudflare\.com)/);
      if (match && !done) {
        done = true;
        resolve({ child, domain: match[1] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!done) reject(new Error(`临时隧道提前退出 (code: ${code})`));
    });
  });
}

async function main() {
  const coreBin = path.join(npmDir, 'mybot');
  if (!fs.existsSync(coreBin)) {
    console.log('正在下载核心二进制文件...');
    const binName = arch === 'x64' ? 'mybot-linux-amd64' : 'mybot-linux-arm64';
    await downloadFile(`https://github.com/sumtie/files/releases/download/261109/${binName}`, coreBin);
    fs.chmodSync(coreBin, 0o755);
  }

  const fullchainPath = path.join(npmDir, 'fullchain.pem');
  const privkeyPath = path.join(npmDir, 'privkey.pem');
  if (!fs.existsSync(fullchainPath) || !fs.existsSync(privkeyPath)) {
    console.log('正在生成自签证书...');
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'bing.com' }], { days: 365, keySize: 2048 });
    fs.writeFileSync(fullchainPath, pems.cert);
    fs.writeFileSync(privkeyPath, pems.private);
  }
  const sha256Pin = new crypto.X509Certificate(fs.readFileSync(fullchainPath)).fingerprint256;

  const isFixedTunnel = Boolean(argoToken); // 有 token -> 固定隧道 + vless+xhttp；无 token -> 临时隧道 + vless+ws
  const cloudflaredBin = path.join(npmDir, 'cloudflared');

  if (onArgo && !fs.existsSync(cloudflaredBin)) {
    console.log('ON_ARGO 已开启，正在下载 cloudflared...');
    const cfArch = arch === 'x64' ? 'amd64' : 'arm64';
    await downloadFile(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfArch}`, cloudflaredBin);
    fs.chmodSync(cloudflaredBin, 0o755);
  }

  const inbounds = [
    {
      listen: '0.0.0.0',
      port: parseInt(hy2Port, 10),
      protocol: 'hysteria',
      settings: { version: 2, clients: [{ auth: password }] },
      streamSettings: {
        network: 'hysteria',
        security: 'tls',
        hysteriaSettings: { version: 2 },
        tlsSettings: { certificates: [{ certificateFile: fullchainPath, keyFile: privkeyPath }] },
        finalmask: {
          quicParams: { congestion: 'brutal', brutalUp: '150 Mbps', brutalDown: '120 Mbps' }
        }
      }
    }
  ];

  if (onArgo) {
    inbounds.push({
      listen: '127.0.0.1',
      port: parseInt(argoPort, 10),
      protocol: 'vless',
      settings: { clients: [{ id: uuid }], decryption: 'none' },
      streamSettings: isFixedTunnel
        ? { network: 'xhttp', xhttpSettings: { path: `/${nodePath}` } }
        : { network: 'ws', wsSettings: { path: `/${nodePath}` } }
    });
  }

  const configFile = path.join(npmDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    log: { loglevel: enableLog ? 'warning' : 'none' },
    inbounds,
    outbounds: [{ protocol: 'freedom' }]
  }, null, 2));

  let serverIp = '127.0.0.1';
  try {
    const ipRes = await fetch('https://api.ipify.org');
    if (ipRes.ok) serverIp = (await ipRes.text()).trim() || '127.0.0.1';
  } catch (e) {}

  const coreProcess = spawn(coreBin, ['run', '-c', configFile], {
    stdio: enableLog ? 'inherit' : 'ignore'
  });

  let argoProcess = null;
  let tunnelDomain = argoDomain;

  if (onArgo) {
    if (isFixedTunnel) {
      argoProcess = spawn(cloudflaredBin, ['tunnel', '--no-autoupdate', 'run', '--token', argoToken], {
        stdio: enableLog ? 'inherit' : 'ignore'
      });
    } else {
      console.log('未检测到 ARGO_TOKEN，正在启动临时隧道...');
      const quick = await startQuickTunnel(cloudflaredBin);
      argoProcess = quick.child;
      tunnelDomain = quick.domain;
    }
  }

  const links = [
    `hysteria2://${password}@${serverIp}:${hy2Port}?sni=bing.com&insecure=1&pinSHA256=${sha256Pin}&congestion=brutal&up=150Mbps&down=120Mbps#Hysteria2-Brutal`
  ];

  if (onArgo) {
    const host = tunnelDomain || serverIp;
    links.push(
      isFixedTunnel
        ? `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=xhttp&host=${host}&path=%2F${nodePath}&mode=auto#XHTTP-Argo`
        : `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=%2F${nodePath}#WS-QuickArgo`
    );
  }

  const linksFile = path.join(npmDir, 'links.txt');
  fs.writeFileSync(linksFile, links.join('\n') + '\n');

  console.log('\n=== 部署完成 ===');
  links.forEach(l => console.log(l));
  console.log(`节点链接已写入: ${linksFile}\n`);

  process.on('SIGINT', () => {
    coreProcess.kill();
    if (argoProcess) argoProcess.kill();
    process.exit();
  });
}

main().catch(err => {
  console.error('运行出错:', err);
  process.exit(1);
});