const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

const NPM_DIR = path.join(__dirname, '.npm');
const STATE_FILE = path.join(NPM_DIR, 'state.json');
const LINKS_FILE = path.join(NPM_DIR, 'links.txt');
const XRAY_BIN = path.join(NPM_DIR, 'xray');
const CONFIG_FILE = path.join(NPM_DIR, 'config.json');
const CLOUDFLARED_BIN = path.join(NPM_DIR, 'cloudflared');

const PORT = process.env.PORT || 8080;
const ARGO_PORT = process.env.ARGO_PORT || PORT;
const ARGO_TOKEN = process.env.ARGO_TOKEN || '';
// 固定隧道绑定的域名（当有 ARGO_TOKEN 时必须填写此环境变量或固定域名，例如 argo.yourdomain.com）
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';

if (!fs.existsSync(NPM_DIR)) fs.mkdirSync(NPM_DIR, { recursive: true });

// 1. 状态持久化加载/生成
function loadState() {
    let state = {};
    if (fs.existsSync(STATE_FILE)) {
        try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
    }
    if (!state.uuid) state.uuid = crypto.randomUUID();
    if (!state.wsPath) state.wsPath = '/' + crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return state;
}

// 通用流式下载方法（防止 OOM）
async function streamDownload(url, destPath) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.statusText} for ${url}`);
    
    const fileStream = fs.createWriteStream(destPath);
    const reader = res.body.getReader();
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
    }
    fileStream.end();
    await new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
    });
}

// 2. 流式下载并解压 Xray
async function setupXray() {
    if (fs.existsSync(XRAY_BIN)) return;
    const archMap = { x64: '64', arm64: 'arm64-v8a' };
    const arch = archMap[process.arch] || '64';
    const url = `https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-${arch}.zip`;
    
    console.log(`Downloading Xray from ${url}...`);
    const zipPath = path.join(NPM_DIR, 'xray.zip');
    
    await streamDownload(url, zipPath);

    console.log('Extracting Xray...');
    execSync(`unzip -o ${zipPath} xray -d ${NPM_DIR} && chmod +x ${XRAY_BIN}`);
    fs.unlinkSync(zipPath);
}

// 3. 生成 Xray 官方标准配置
function writeXrayConfig(uuid, wsPath) {
    const config = {
        log: { loglevel: "none" },
        inbounds: [{
            port: PORT,
            listen: "127.0.0.1",
            protocol: "vless",
            settings: {
                clients: [{ id: uuid, level: 0 }],
                decryption: "none"
            },
            streamSettings: {
                network: "ws",
                wsSettings: { path: wsPath }
            }
        }],
        outbounds: [{ protocol: "freedom" }]
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// 4. 生成标准节点链接
function generateLink(uuid, domain, wsPath, remark) {
    return `vless://${uuid}@${domain}:443?encryption=none&security=tls&sni=${domain}&type=ws&host=${domain}&path=${encodeURIComponent(wsPath)}#${remark}`;
}

// 5. 流式下载并启动 Cloudflare Argo 隧道
async function setupAndStartArgo(state) {
    if (!fs.existsSync(CLOUDFLARED_BIN)) {
        const platform = process.arch === 'arm64' ? 'arm64' : 'amd64';
        const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${platform}`;
        
        console.log(`Downloading cloudflared from ${url}...`);
        await streamDownload(url, CLOUDFLARED_BIN);
        fs.chmodSync(CLOUDFLARED_BIN, '755');
    }

    if (ARGO_TOKEN) {
        // 固定隧道
        spawn(CLOUDFLARED_BIN, ['tunnel', '--edge-ip-version', 'auto', 'run', '--token', ARGO_TOKEN], { stdio: 'inherit' });
        console.log("Argo tunnel started with fixed token.");

        if (ARGO_DOMAIN) {
            const link = generateLink(state.uuid, ARGO_DOMAIN, state.wsPath, "Argo-Fixed-VLESS");
            fs.writeFileSync(LINKS_FILE, link + '\n');
            console.log(`\n=================== 固定隧道节点链接 ===================\n${link}\n======================================================`);
        } else {
            console.log("提示: 已启用固定隧道，但未检测到 ARGO_DOMAIN 环境变量，请自行根据绑定的域名拼接链接。");
        }
    } else {
        // 临时隧道
        const cp = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://127.0.0.1:${ARGO_PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
        cp.stderr.on('data', (data) => {
            const match = data.toString().match(/https:\/\/([a-zA-Z0-9-]+\.trycloudflare\.com)/);
            if (match) {
                const domain = match[1];
                const link = generateLink(state.uuid, domain, state.wsPath, "Argo-VLESS");
                fs.writeFileSync(LINKS_FILE, link + '\n');
                console.log(`\n=================== 临时隧道节点链接 ===================\n${link}\n======================================================`);
            }
        });
    }
}

// 主流程
async function main() {
    const state = loadState();
    await setupXray();
    writeXrayConfig(state.uuid, state.wsPath);

    console.log(`Starting Xray core on port ${PORT}...`);
    spawn(XRAY_BIN, ['run', '-config', CONFIG_FILE], { stdio: 'inherit' });

    await setupAndStartArgo(state);
}

main().catch(console.error);