# 与 Gemini 对话

##### 你说 编写index.js， fetch下载https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-l…

编写index.js，

fetch下载https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-amd64-musl.tar.gz, 防止OOM

tar解压 部署在nodejs主机上，只考虑linux系统amd64和arm64。

部署vless+ws搭配cloudflared隧道节点，uuid随机生成，ARGO_TOKEN有填写就固定隧道，没有就临时隧道，ARGO_PORT默认8080，WS_PATH随机生成

uuid、WS_PATH存到.npm/state.json里面，重启可复用

节点协议链接存到.npm/links.txt

index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，

以sing-box官方最新文档https://sing-box.sagernet.org/为主，编写代码配置

简洁代码

###### Gemini 说

为您编写的 `index.js` 代码。代码符合官方 `sing-box` 配置规范，使用流式下载（防止 OOM），支持 Linux `amd64` 和 `arm64` 架构，实现了状态复用（`state.json`）以及链接保存（`links.txt`）。



### `index.js` 源码



```JavaScript
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');

const NPM_DIR = path.join(__dirname, '.npm');
if (!fs.existsSync(NPM_DIR)) fs.mkdirSync(NPM_DIR, { recursive: true });

const ARCH = os.arch();
const isArm = ARCH === 'arm64';

// 动态匹配架构文件名
const SING_BOX_TAR = isArm ? 'sing-box-1.14.4-linux-arm64.tar.gz' : 'sing-box-1.14.4-linux-amd64-musl.tar.gz';
const SING_BOX_URL = `https://github.com/SagerNet/sing-box/releases/download/v1.14.4/${SING_BOX_TAR}`;
const CLOUDFLARED_URL = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${isArm ? 'arm64' : 'amd64'}`;

const singBoxBin = path.join(NPM_DIR, 'sing-box');
const cloudflaredBin = path.join(NPM_DIR, 'cloudflared');

// 防止OOM：使用 stream pipeline 下载大文件
async function download(url, dest) {
    if (fs.existsSync(dest)) return;
    console.log(`正在下载: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: ${res.statusText}`);
    await pipeline(res.body, fs.createWriteStream(dest));
}

async function main() {
    // 1. 下载并解压 sing-box
    const tarPath = path.join(NPM_DIR, SING_BOX_TAR);
    if (!fs.existsSync(singBoxBin)) {
        await download(SING_BOX_URL, tarPath);
        console.log('正在解压 sing-box...');
        spawnSync('tar', ['-xzf', tarPath, '-C', NPM_DIR, '--strip-components=1']);
        if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
        fs.chmodSync(singBoxBin, '755');
    }

    // 2. 下载 cloudflared
    if (!fs.existsSync(cloudflaredBin)) {
        await download(CLOUDFLARED_URL, cloudflaredBin);
        fs.chmodSync(cloudflaredBin, '755');
    }

    // 3. 状态管理 (UUID & WS_PATH 复用)
    const statePath = path.join(NPM_DIR, 'state.json');
    let state = {};
    if (fs.existsSync(statePath)) {
        try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) {}
    }
    state.uuid = state.uuid || crypto.randomUUID();
    state.wsPath = state.wsPath || '/' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const port = process.env.ARGO_PORT || 8080;
    const argoToken = process.env.ARGO_TOKEN;
    const argoDomain = process.env.ARGO_DOMAIN;

    // 4. 生成 sing-box 配置文件（官方规范）
    const config = {
        log: { level: 'info' },
        inbounds: [
            {
                type: 'vless',
                tag: 'vless-in',
                listen: '127.0.0.1',
                listen_port: Number(port),
                users: [{ uuid: state.uuid }],
                transport: {
                    type: 'ws',
                    path: state.wsPath
                }
            }
        ],
        outbounds: [{ type: 'direct', tag: 'direct' }]
    };
    const configPath = path.join(NPM_DIR, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // 5. 启动 sing-box
    console.log('正在启动 sing-box...');
    spawn(singBoxBin, ['run', '-c', configPath], { stdio: 'inherit' });

    // 6. 启动 Cloudflared 隧道并生成节点协议链接
    const linksPath = path.join(NPM_DIR, 'links.txt');

    if (argoToken) {
        console.log('使用固定 Argo 隧道 (ARGO_TOKEN)...');
        spawn(cloudflaredBin, ['tunnel', 'run', '--token', argoToken], { stdio: 'inherit' });
        if (argoDomain) {
            const link = `vless://${state.uuid}@${argoDomain}:443?encryption=none&security=tls&type=ws&path=${encodeURIComponent(state.wsPath)}&sni=${argoDomain}#Argo-Fixed-Node`;
            fs.writeFileSync(linksPath, link);
            console.log(`\n=== VLESS 固定节点链接 ===\n${link}\n==========================\n`);
        }
    } else {
        console.log('使用临时 Argo 隧道 (Quick Tunnel)...');
        const cfProc = spawn(cloudflaredBin, ['tunnel', '--url', `http://127.0.0.1:${port}`]);

        cfProc.stderr.on('data', (data) => {
            const output = data.toString();
            const match = output.match(/https:\/\/([a-zA-Z0-9-]+\.trycloudflare\.com)/);
            if (match) {
                const domain = match[1];
                const link = `vless://${state.uuid}@${domain}:443?encryption=none&security=tls&type=ws&path=${encodeURIComponent(state.wsPath)}&sni=${domain}#Argo-Quick-Node`;
                fs.writeFileSync(linksPath, link);
                console.log(`\n=== VLESS 临时节点链接 ===\n${link}\n==========================\n`);
            }
        });
    }
}

main().catch(err => {
    console.error('运行出错:', err);
    process.exit(1);
});
```

### 使用说明

1. **环境准备**：确保你的主机为 **Linux (amd64 / arm64)** 并安装了 **Node.js (>= 18)**（Node 18+ 原生支持全局 `fetch`）。

   GitHub

2. **运行脚本**：

   + **临时隧道模式**（默认）：

     Bash

     ```
     node index.js
     ```

   + **固定隧道模式**（如有 Token 和 自定义域名）：

     Bash

     ```
     export ARGO_TOKEN="你的Argo_Token"
     export ARGO_DOMAIN="你的域名"
     export ARGO_PORT=8080 # 可选，默认8080
     node index.js
     ```

3. **查看生成的文件**：

   + 同目录下会自动生成 `.npm/` 文件夹。
   + `.npm/state.json` 保存了 `uuid` 与 `WS_PATH`，重启后自动复用。
   + `.npm/links.txt` 保存了客户端可直接导入的 `vless://` 节点链接。
