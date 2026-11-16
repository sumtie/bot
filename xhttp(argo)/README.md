注意：临时隧道不支持xhttp，只能使用固定隧道。也就是必须有域名(免费域名也可以)托管在cloudflare上面，创建固定隧道Tunnel来使用。

# 与 Gemini 对话

##### 你说 编写index.js， fetch下载https\://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-64.zip，防…

编写index.js，

fetch下载https\://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-64.zip，防止OOM

fetch下载cloudflared最新版，防止OOM

tar解压 部署在nodejs主机上，只考虑linux系统amd64和arm64。

部署vless+xhttp搭配cloudflared固定隧道节点，uuid随机生成，ARGO\_TOKEN必须填写，ARGO\_PORT默认8080，ARGO\_DOMAIN默认为yourArgo.com，XHTTPPATH随机生成

uuid、XHTTPPATH存到.npm/state.json里面，重启可复用

节点协议链接存到.npm/links.txt

index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，

简洁代码

###### Gemini 说

以下是为您编写的精简版 `index.js`。代码采用流式写入与分块下载（`ReadableStream` 搭配 `pipeline`），有效防止大文件下载及解压时占用过多内存导致 OOM。同时自动检测系统的 `arch`（`x64` 或 `arm64`），适配 Xray 与 Cloudflared 的官方二进制。

### `index.js` 源码

JavaScript

```
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { spawn, execSync } from 'child_process';
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
if (!state.xhttpPath) state.xhttpPath = '/' + crypto.randomBytes(4).toString('hex');
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const UUID = state.uuid;
const XHTTP_PATH = state.xhttpPath;
const ARGO_TOKEN = process.env.ARGO_TOKEN;
const ARGO_PORT = process.env.ARGO_PORT || 8080;
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || 'yourArgo.com';

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
    const fileStream = fs.createWriteStream(dest);
    await pipeline(res.body, fileStream);
}

// 3. 架构适配与核心二进制下载部署
async function setupBinaries() {
    const arch = process.arch === 'arm64' ? 'arm64-v8a' : '64'; // Xray命名惯例
    const cfArch = process.arch === 'arm64' ? 'arm64' : 'amd64';

    const xrayZip = path.join(NPM_DIR, 'xray.zip');
    const xrayUrl = `https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-${arch}.zip`;
    const cfUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfArch}`;

    await downloadFile(xrayUrl, xrayZip);
    await downloadFile(cfUrl, CF_BIN);
    fs.chmodSync(CF_BIN, 0o755);

    // 解压 Xray (Linux下使用内置unzip或tar)
    if (!fs.existsSync(XRAY_BIN)) {
        console.log('Extracting Xray...');
        execSync(`unzip -qo ${xrayZip} xray -d ${NPM_DIR}`);
        fs.chmodSync(XRAY_BIN, 0o755);
    }
}

// 4. 生成 Xray 配置文件
function createXrayConfig() {
    const config = {
        log: { loglevel: 'warning' },
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
    const link = `vless://${UUID}@${ARGO_DOMAIN}:443?encryption=none&security=tls&type=xhttp&path=${encodeURIComponent(XHTTP_PATH)}&sni=${ARGO_DOMAIN}#Argo-XHTTP`;
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
    
    // 启动 Xray
    const xray = spawn(XRAY_BIN, ['run', '-config', path.join(NPM_DIR, 'config.json')], { stdio: 'inherit' });
    xray.on('error', (err) => console.error('Xray error:', err));

    // 启动 Cloudflared 隧道
    const cf = spawn(CF_BIN, ['tunnel', '--no-autoupdate', 'run', '--token', ARGO_TOKEN], { stdio: 'inherit' });
    cf.on('error', (err) => console.error('Cloudflared error:', err));
}

main().catch(err => {
    console.error('Initialization error:', err);
    process.exit(1);
});
```

### 使用说明

1. **依赖准备**：确保宿主机安装了 `unzip` 工具（用于解压 Xray 的 zip 包，精简代码体积）。

2. **环境变量运行**：

   Bash

   ```
   ARGO_TOKEN="你的Cloudflare隧道Token" ARGO_DOMAIN="yourArgo.com" node index.js
   ```

3. **查看链接**：生成的节点协议链接会自动保存在 `.npm/links.txt` 文件中，并实时打印在控制台。

##### 你说 补全生成的节点协议链接，应该是vless\://cf9d9c33-c327-49f8-bff2-b116711b81f3\@yourArgo.com:443?encryption=none\&securit…

补全生成的节点协议链接，应该是vless\://cf9d9c33-c327-49f8-bff2-b116711b81f3\@yourArgo.com:443?encryption=none\&security=tls\&sni=yourArgo.com\&type=xhttp\&host=yourArgo.com\&path=%2F893768ae\&mode=auto#Argo-XHTTP

###### Gemini 说

修改 `index.js` 中的 `generateLinks()` 函数，将分享链接更新为标准完整的格式（包含了 `host` 参数和 `mode=auto`）：

### 修改后的 `generateLinks` 函数

JavaScript

```
// 5. 生成节点分享链接
function generateLinks() {
    const link = `vless://${UUID}@${ARGO_DOMAIN}:443?encryption=none&security=tls&sni=${ARGO_DOMAIN}&type=xhttp&host=${ARGO_DOMAIN}&path=${encodeURIComponent(XHTTP_PATH)}&mode=auto#Argo-XHTTP`;
    fs.writeFileSync(LINKS_FILE, link + '\n');
    console.log('\n--- Node Connection Link ---');
    console.log(link);
    console.log('----------------------------\n');
}
```

### 完整的 `index.js` 代码（更新后）

将以下完整代码覆盖你本地的 `index.js` 文件即可：

JavaScript

```
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { spawn, execSync } from 'child_process';
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
if (!state.xhttpPath) state.xhttpPath = '/' + crypto.randomBytes(4).toString('hex');
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const UUID = state.uuid;
const XHTTP_PATH = state.xhttpPath;
const ARGO_TOKEN = process.env.ARGO_TOKEN;
const ARGO_PORT = process.env.ARGO_PORT || 8080;
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || 'yourArgo.com';

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
    const fileStream = fs.createWriteStream(dest);
    await pipeline(res.body, fileStream);
}

// 3. 架构适配与核心二进制下载部署
async function setupBinaries() {
    const arch = process.arch === 'arm64' ? 'arm64-v8a' : '64'; // Xray命名惯例
    const cfArch = process.arch === 'arm64' ? 'arm64' : 'amd64';

    const xrayZip = path.join(NPM_DIR, 'xray.zip');
    const xrayUrl = `https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-${arch}.zip`;
    const cfUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfArch}`;

    await downloadFile(xrayUrl, xrayZip);
    await downloadFile(cfUrl, CF_BIN);
    fs.chmodSync(CF_BIN, 0o755);

    // 解压 Xray
    if (!fs.existsSync(XRAY_BIN)) {
        console.log('Extracting Xray...');
        execSync(`unzip -qo ${xrayZip} xray -d ${NPM_DIR}`);
        fs.chmodSync(XRAY_BIN, 0o755);
    }
}

// 4. 生成 Xray 配置文件
function createXrayConfig() {
    const config = {
        log: { loglevel: 'warning' },
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

// 5. 生成节点分享链接（已补全参数）
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
    
    // 启动 Xray
    const xray = spawn(XRAY_BIN, ['run', '-config', path.join(NPM_DIR, 'config.json')], { stdio: 'inherit' });
    xray.on('error', (err) => console.error('Xray error:', err));

    // 启动 Cloudflared 隧道
    const cf = spawn(CF_BIN, ['tunnel', '--no-autoupdate', 'run', '--token', ARGO_TOKEN], { stdio: 'inherit' });
    cf.on('error', (err) => console.error('Cloudflared error:', err));
}

main().catch(err => {
    console.error('Initialization error:', err);
    process.exit(1);
});
```
