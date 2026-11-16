import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import crypto from 'crypto';

const NPM_DIR = path.join(import.meta.dirname, '.npm');
const STATE_FILE = path.join(NPM_DIR, 'state.json');
const LINKS_FILE = path.join(NPM_DIR, 'links.txt');
const XRAY_BIN = path.join(NPM_DIR, 'xray');
const CF_BIN = path.join(NPM_DIR, 'cloudflared');

// 确保 .npm 目录存在
if (!fs.existsSync(NPM_DIR)) fs.mkdirSync(NPM_DIR, { recursive: true });

// 1. 读取或初始化状态
let state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) : {};
if (!state.uuid) state.uuid = crypto.randomUUID();
if (!state.xhttpPath) state.xhttpPath = '/' + crypto.randomBytes(6).toString('hex');
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const UUID = state.uuid;
const XHTTP_PATH = state.xhttpPath;
const ARGO_TOKEN = process.env.ARGO_TOKEN || '';
const ARGO_PORT = process.env.ARGO_PORT || 8080;
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
// 日志开关：默认 false，关闭日志，可设为 true 开启日志
const enableLog = false; // true | false

if (!ARGO_TOKEN) {
    console.error('Error: ARGO_TOKEN environment variable is required.');
    process.exit(1);
}

// 2. 内存安全的流式下载函数
async function downloadFile(url, dest) {
    if (fs.existsSync(dest)) return;
    console.log(`Downloading ${url} ...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
    await pipeline(res.body, fs.createWriteStream(dest));
}

// 零依赖原生提取 ZIP 中的指定文件
function extractFromZip(zipPath, targetName, destPath) {
    const buf = fs.readFileSync(zipPath);
    let offset = 0;
    while (offset + 30 < buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
        const method = buf.readUInt16LE(offset + 8);
        const compSize = buf.readUInt32LE(offset + 18);
        const nameLen = buf.readUInt16LE(offset + 26);
        const extraLen = buf.readUInt16LE(offset + 28);
        const fileName = buf.toString('utf8', offset + 30, offset + 30 + nameLen);
        const dataStart = offset + 30 + nameLen + extraLen;

        if (fileName === targetName) {
            const raw = buf.subarray(dataStart, dataStart + compSize);
            const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
            fs.writeFileSync(destPath, data, { mode: 0o755 });
            return;
        }
        offset = dataStart + compSize;
    }
    throw new Error(`${targetName} not found in ${zipPath}`);
}

// 3. 架构适配与核心二进制下载部署
async function setupBinaries() {
    const arch = process.arch === 'arm64' ? 'arm64-v8a' : '64';
    const cfArch = process.arch === 'arm64' ? 'arm64' : 'amd64';

    const xrayZip = path.join(NPM_DIR, 'xray.zip');
    const xrayUrl = `https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-${arch}.zip`;
    const cfUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfArch}`;

    await downloadFile(xrayUrl, xrayZip);
    await downloadFile(cfUrl, CF_BIN);
    fs.chmodSync(CF_BIN, 0o755);

    // 原生解压 Xray
    if (!fs.existsSync(XRAY_BIN)) {
        console.log('Extracting Xray...');
        extractFromZip(xrayZip, 'xray', XRAY_BIN);
    }
}

// 4. 生成 Xray 配置文件
function createXrayConfig() {
    const config = {
        log: { loglevel: enableLog ? 'warning' : 'none' },
        inbounds: [{
            port: Number(ARGO_PORT),
            protocol: 'vless',
            settings: {
                clients: [{ id: UUID, level: 0 }],
                decryption: 'none'
            },
            streamSettings: {
                network: 'xhttp',
                xhttpSettings: { path: XHTTP_PATH }
            }
        }],
        outbounds: [{ protocol: 'freedom' }]
    };
    fs.writeFileSync(path.join(NPM_DIR, 'config.json'), JSON.stringify(config, null, 2));
}

// 5. 生成节点分享链接
function generateLinks() {
    const link = `vless://${UUID}@${ARGO_DOMAIN}:443?encryption=none&security=tls&sni=${ARGO_DOMAIN}&type=xhttp&host=${ARGO_DOMAIN}&path=${encodeURIComponent(XHTTP_PATH)}&mode=auto#Argo-XHTTP`;
    fs.writeFileSync(LINKS_FILE, link + '\n');
    console.log('\n--- Node Connection Link ---');
    console.log(link);
    console.log('----------------------------\n');
}

// 6. 启动服务
async function main() {
    await setupBinaries();
    createXrayConfig();
    generateLinks();

    console.log('Starting Xray and Cloudflared...');
    const stdioMode = enableLog ? 'inherit' : 'ignore';
    
    const xray = spawn(XRAY_BIN, ['run', '-config', path.join(NPM_DIR, 'config.json')], { stdio: stdioMode });
    xray.on('error', (err) => console.error('Xray error:', err));

    const cf = spawn(CF_BIN, ['tunnel', '--no-autoupdate', 'run', '--token', ARGO_TOKEN], { stdio: stdioMode });
    cf.on('error', (err) => console.error('Cloudflared error:', err));
}

main().catch(err => {
    console.error('Initialization error:', err);
    process.exit(1);
});
