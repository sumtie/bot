const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const { X509Certificate } = crypto;
const https = require("https");

// 统一将所有生成的文件存放在 .npm 目录下
const npmDir = path.join(__dirname, '.npm');
if (!fs.existsSync(npmDir)) {
    fs.mkdirSync(npmDir, { recursive: true });
}

const singBoxPath = path.join(npmDir, 'sing-box');
const cloudflaredPath = path.join(npmDir, 'cloudflared');
const configPath = path.join(npmDir, 'config.json');
const certPath = path.join(npmDir, 'cert.pem');
const keyPath = path.join(npmDir, 'key.pem');
const pwdPath = path.join(npmDir, 'pwd.txt'); // 密码保存路径
const uuidPath = path.join(npmDir, 'u.txt');  // UUID 保存路径

// 获取环境变量并确保端口是数字类型
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const ARGO_PORT = process.env.ARGO_PORT ? parseInt(process.env.ARGO_PORT, 10) : 0;
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';

// UUID 复用逻辑：优先环境变量 -> 其次读取本地文件 -> 最后自动生成并保存
let UUID;
if (process.env.UUID) {
    UUID = process.env.UUID;
    console.log('[Info] 使用环境变量中的 UUID。');
} else if (fs.existsSync(uuidPath)) {
    UUID = fs.readFileSync(uuidPath, 'utf8').trim();
    console.log('[Info] 检测到已保存的 UUID，已成功复用。');
} else {
    UUID = crypto.randomUUID();
    fs.writeFileSync(uuidPath, UUID, 'utf8');
    console.log('[Info] 首次运行，已生成新 UUID 并写入 .npm/u.txt。');
}

async function getPublicIP() {
  const fetchIP = (url) => new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 3500 }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        const ip = data.trim();
        ip ? resolve(ip) : reject(new Error("Empty"));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });

  return fetchIP("https://api.ipify.org")
    .catch(() => fetchIP("https://ipv4.icanhazip.com"))
    .catch(() => "127.0.0.1");
}

async function downloadFile(url, dest) {
    console.log(`[Info] 正在从官方下载: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: ${res.statusText}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buffer);
    console.log('[Info] 下载完成。');
}

function printVlessConfig(domain, uuid) {
    console.log('\n==================== VLESS + WS + TLS Argo 节点配置信息 ====================');
    console.log(`UUID: ${uuid}`);
    console.log(`伪装域名 / SNI / 节点地址: ${domain}`);
    console.log(`传输模式: ws`);
    console.log(`WebSocket 路径: /`);
    console.log(`TLS: 开启`);
    console.log('\n--- 🔗 VLESS 分享链接 ---');
    console.log(`vless://${uuid}@${domain}:443?encryption=none&security=tls&type=ws&host=${domain}&path=%2F#Argo-VLESS`);
    console.log('===========================================================================\n');
}

async function main() {
    try {
        const publicIp = await getPublicIP();

        // 判断 Argo 隧道模式
        const useFixedTunnel = Boolean(ARGO_AUTH && ARGO_PORT);
        const useQuickTunnel = Boolean(!ARGO_AUTH && ARGO_PORT);
        const needArgo = useFixedTunnel || useQuickTunnel;

        // 1. 检查并下载 sing-box v1.11.4
        if (!fs.existsSync(singBoxPath)) {
            const downloadUrl = 'https://github.com/SagerNet/sing-box/releases/download/v1.11.4/sing-box-1.11.4-linux-amd64.tar.gz';
            const tarPath = path.join(npmDir, 'sing-box.tar.gz');
            
            await downloadFile(downloadUrl, tarPath);
            
            console.log('[Info] 正在解压 sing-box...');
            execSync(`tar -xzf "${tarPath}" -C "${npmDir}" --strip-components=1`, { stdio: 'inherit' });
            
            if (fs.existsSync(tarPath)) {
                fs.unlinkSync(tarPath);
            }
            
            execSync(`chmod +x "${singBoxPath}"`);
            console.log('[Info] sing-box 安装并授权成功。');
        } else {
            console.log('[Info] 检测到 sing-box 已存在，跳过下载。');
        }

        // 2. 根据条件检查并下载 cloudflared 二进制程序
        if (needArgo) {
            if (!fs.existsSync(cloudflaredPath)) {
                const cfUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
                await downloadFile(cfUrl, cloudflaredPath);
                execSync(`chmod +x "${cloudflaredPath}"`);
                console.log('[Info] cloudflared 安装并授权成功。');
            } else {
                console.log('[Info] 检测到 cloudflared 已存在，跳过下载。');
            }
        } else {
            console.log('[Info] 未填写 ARGO_AUTH 与 ARGO_PORT，跳过 cloudflared 下载与 Argo 隧道启动。');
        }

        // 3. 检查并生成自签 TLS 证书
        if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
            console.log('[Info] 正在生成自签 TLS 证书...');
            execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 3650 -nodes -subj "/CN=bing.com"`, { stdio: 'inherit' });
            console.log('[Info] TLS 证书生成完毕。');
        }

        const certContent = fs.readFileSync(certPath);
        const x509 = new X509Certificate(certContent);
        const pinSHA256 = x509.fingerprint256.replace(/:/g, '').toLowerCase();

        // 密码复用逻辑：检查 .npm/pwd.txt 是否存在
        let password;
        if (fs.existsSync(pwdPath)) {
            password = fs.readFileSync(pwdPath, 'utf8').trim();
            console.log('[Info] 检测到已保存的密码，已成功复用。');
        } else {
            password = crypto.randomBytes(16).toString('hex');
            fs.writeFileSync(pwdPath, password, 'utf8');
            console.log('[Info] 首次运行，已生成新密码并写入 .npm/pwd.txt。');
        }

        // 4. 编写 sing-box 配置文件 (支持 Hysteria 2 与 VLESS WS 双协议)
        const config = {
            log: {
                disabled: true,
                level: 'panic',
                timestamp: true
            },
            inbounds: [
                {
                    type: 'hysteria2',
                    tag: 'hysteria2-in',
                    listen: '::',
                    listen_port: PORT,
                    users: [
                        {
                            name: 'bot-user',
                            password: password
                        }
                    ],
                    tls: {
                        enabled: true,
                        certificate_path: certPath,
                        key_path: keyPath
                    }
                }
            ],
            outbounds: [
                {
                    type: 'direct',
                    tag: 'direct'
                }
            ]
        };

        // 如果填写了 ARGO_PORT，则加入 VLESS WS 本地监听入站（listen_port 必须为数字）
        if (ARGO_PORT) {
            config.inbounds.push({
                type: 'vless',
                tag: 'vless-in',
                listen: '127.0.0.1',
                listen_port: ARGO_PORT,
                users: [
                    {
                        name: 'vless-user',
                        uuid: UUID
                    }
                ],
                transport: {
                    type: 'ws',
                    path: '/'
                }
            });
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`[Info] 配置文件已写入: ${configPath}`);

        // 5. 打印 Hysteria 2 节点配置信息
        console.log('\n==================== Hysteria 2 节点配置信息 ====================');
        console.log(`监听端口 (Port): ${PORT}`);
        console.log(`认证密码 (Password): ${password}`);
        console.log(`SNI / 伪装域名: bing.com`);
        console.log(`证书指纹 (pinSHA256): ${pinSHA256}`);
        console.log('\n--- 🔗 适配新版 v2rayN 的分享链接 ---');
        console.log(`hysteria2://${password}@${publicIp}:${PORT}?sni=bing.com&pinSHA256=${pinSHA256}#BotHosting-Hy2`);
        console.log('=================================================================\n');

        // 6. 启动 sing-box 进程
        console.log('[Info] 正在启动 sing-box 服务...');
        const singBoxProcess = spawn(singBoxPath, ['run', '-c', configPath], {
            stdio: 'inherit'
        });

        singBoxProcess.on('close', (code) => {
            console.log(`[Warning] sing-box 进程已退出，退出码: ${code}`);
            process.exit(code);
        });

        // 7. 根据条件启动 Cloudflare Argo 隧道
        if (needArgo) {
            let argoArgs = [];
            if (useFixedTunnel) {
                console.log('[Info] 正在启动 Cloudflare 固定隧道...');
                argoArgs = ['tunnel', '--no-autoupdate', 'run', '--token', ARGO_AUTH];
                const domainToUse = ARGO_DOMAIN || '<你的固定域名>';
                printVlessConfig(domainToUse, UUID);
            } else if (useQuickTunnel) {
                console.log('[Info] 正在启动 Cloudflare 临时隧道 (Quick Tunnel)...');
                argoArgs = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${ARGO_PORT}`];
            }

            const argoProcess = spawn(cloudflaredPath, argoArgs, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            argoProcess.stdout.on('data', (data) => {
                const output = data.toString();
                if (useQuickTunnel) {
                    const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
                    if (match && !global.quickTunnelUrl) {
                        global.quickTunnelUrl = match[0];
                        const domain = global.quickTunnelUrl.replace('https://', '');
                        printVlessConfig(domain, UUID);
                    }
                }
                process.stdout.write(`[Argo] ${output}`);
            });

            argoProcess.stderr.on('data', (data) => {
                const output = data.toString();
                if (useQuickTunnel) {
                    const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
                    if (match && !global.quickTunnelUrl) {
                        global.quickTunnelUrl = match[0];
                        const domain = global.quickTunnelUrl.replace('https://', '');
                        printVlessConfig(domain, UUID);
                    }
                }
                process.stderr.write(`[Argo] ${output}`);
            });

            argoProcess.on('close', (code) => {
                console.log(`[Warning] cloudflared 进程已退出，退出码: ${code}`);
            });
        }

    } catch (err) {
        console.error('[Error] 运行过程中发生错误:', err);
        process.exit(1);
    }
}

main();
