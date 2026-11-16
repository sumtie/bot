const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');

// 1. 系统与架构检查
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
if (!fs.existsSync(npmDir)) fs.mkdirSync(npmDir, { recursive: true });

// 2. 加载或初始化持久化状态 (state.json)
const stateFile = path.join(npmDir, 'state.json');
let state = {};
if (fs.existsSync(stateFile)) {
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) {}
}

const password = state.password || crypto.randomBytes(16).toString('hex');
const uuid = state.uuid || crypto.randomUUID();
const xhttpPath = state.xhttpPath || crypto.randomBytes(8).toString('hex');
state = { password, uuid, xhttpPath };
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

const hy2Port = process.env.HY2_PORT || 8443;
const argoPort = process.env.ARGO_PORT || 8080;
const argoDomain = process.env.ARGO_DOMAIN || '';
const argoToken = process.env.ARGO_TOKEN || '';

// 纯 Node.js 实现的 ZIP 解压函数（防止 OOM，适配无 unzip 主机）
function extractZipPureJS(zipPath, targetDir) {
  const buf = fs.readFileSync(zipPath);
  let offset = 0;
  while (offset < buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const compression = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const fileNameLength = buf.readUInt16LE(offset + 26);
    const extraFieldLength = buf.readUInt16LE(offset + 28);
    const fileName = buf.toString('utf8', offset + 30, offset + 30 + fileNameLength);
    
    const dataStart = offset + 30 + fileNameLength + extraFieldLength;
    const dataEnd = dataStart + compressedSize;
    const fileData = buf.subarray(dataStart, dataEnd);
    
    const targetPath = path.join(targetDir, fileName);
    if (fileName.endsWith('/')) {
      fs.mkdirSync(targetPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      if (compression === 8) {
        fs.writeFileSync(targetPath, zlib.inflateRawSync(fileData));
      } else if (compression === 0) {
        fs.writeFileSync(targetPath, fileData);
      }
    }
    offset = dataEnd;
  }
}

// 3. 使用 curl 下载 Xray-core 并解压
const xrayBin = path.join(npmDir, 'xray');
if (!fs.existsSync(xrayBin)) {
  console.log('正在下载 Xray-core...');
  const xrayZipName = arch === 'x64' ? 'Xray-linux-64.zip' : 'Xray-linux-arm64-v8a.zip';
  const xrayUrl = `https://github.com/XTLS/Xray-core/releases/download/v26.11.9/${xrayZipName}`;
  const zipPath = path.join(npmDir, 'xray.zip');
  
  execSync(`curl -L "${xrayUrl}" -o "${zipPath}"`, { stdio: 'inherit' });
  extractZipPureJS(zipPath, npmDir);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  execSync(`chmod +x "${xrayBin}"`);
}

// 4. OpenSSL 自签证书及计算 SHA-256 冒号指纹 (如 61:BC:FD:70:...)
const fullchainPath = path.join(npmDir, 'fullchain.pem');
const privkeyPath = path.join(npmDir, 'privkey.pem');
if (!fs.existsSync(fullchainPath) || !fs.existsSync(privkeyPath)) {
  console.log('正在生成 OpenSSL 自签证书...');
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${privkeyPath}" -out "${fullchainPath}" -days 365 -nodes -subj "/CN=bing.com"`, { stdio: 'ignore' });
}

const fpOutput = execSync(`openssl x509 -noout -fingerprint -sha256 -in "${fullchainPath}"`).toString().trim();
const sha256Pin = fpOutput.split('=')[1]; 

// 5. Cloudflared 下载（仅在有 ARGO_TOKEN 时）
const cloudflaredBin = path.join(npmDir, 'cloudflared');
let enableArgo = false;
if (argoToken && argoToken.trim() !== '') {
  enableArgo = true;
  if (!fs.existsSync(cloudflaredBin)) {
    console.log('检测到 ARGO_TOKEN，正在下载 cloudflared...');
    const cfArch = arch === 'x64' ? 'amd64' : 'arm64';
    const cfUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfArch}`;
    execSync(`curl -L "${cfUrl}" -o "${cloudflaredBin}"`, { stdio: 'inherit' });
    execSync(`chmod +x "${cloudflaredBin}"`);
  }
}

// 6. 生成最新版 Xray 配置文件 (config.json)
const inbounds = [
  {
    "listen": "0.0.0.0",
    "port": parseInt(hy2Port),
    "protocol": "hysteria",
    "settings": {
      "version": 2,
      "clients": [{ "auth": password }]
    },
    "streamSettings": {
      "network": "hysteria",
      "security": "tls",
      "hysteriaSettings": { "version": 2 },
      "tlsSettings": {
        "certificates": [{ "certificateFile": fullchainPath, "keyFile": privkeyPath }]
      },
      "finalmask": {
        "quicParams": {
          "congestion": "brutal",
          "brutalUp": "20 Mbps",
          "brutalDown": "100 Mbps"
        }
      }
    }
  }
];

if (enableArgo) {
  inbounds.push({
    "listen": "127.0.0.1",
    "port": parseInt(argoPort),
    "protocol": "vless",
    "settings": {
      "clients": [{ "id": uuid }],
      "decryption": "none"
    },
    "streamSettings": {
      "network": "xhttp",
      "xhttpSettings": { "path": "/" + xhttpPath }
    }
  });
}

const xrayConfig = {
  "log": { "loglevel": "warning" },
  "inbounds": inbounds,
  "outbounds": [{ "protocol": "freedom" }]
};

fs.writeFileSync(path.join(npmDir, 'config.json'), JSON.stringify(xrayConfig, null, 2));

// 7. 生成节点协议链接并存入 links.txt
let serverIp = '127.0.0.1';
try {
  serverIp = execSync('curl -s https://api.ipify.org').toString().trim() || '127.0.0.1';
} catch (e) {}

let links = [
  `hysteria2://${password}@${serverIp}:${hy2Port}?sni=bing.com&insecure=1&pinSHA256=${sha256Pin}&congestion=brutal&up=20Mbps&down=100Mbps#Hysteria2-Brutal`
];

if (enableArgo) {
  links.push(`vless://${uuid}@${argoDomain}:443?encryption=none&security=tls&sni=${argoDomain}&type=xhttp&host=${argoDomain}&path=%2F${xhttpPath}&mode=auto#VLESS-XHTTP-Argo`);
}

const linksFile = path.join(npmDir, 'links.txt');
fs.writeFileSync(linksFile, links.join('\n') + '\n');

console.log('\n=== 部署完成 ===');
links.forEach(l => console.log(l));
console.log(`节点链接已写入: ${linksFile}\n`);

// 8. 启动服务
const configFile = path.join(npmDir, 'config.json');
const xrayProcess = spawn(xrayBin, ['run', '-c', configFile], { stdio: 'inherit' });

if (enableArgo) {
  spawn(cloudflaredBin, ['tunnel', '--no-autoupdate', 'run', '--token', argoToken], { stdio: 'inherit' });
}

process.on('SIGINT', () => {
  xrayProcess.kill();
  process.exit();
});