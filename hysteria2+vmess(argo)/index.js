const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const { X509Certificate } = crypto; // 引入内置证书解析工具
const https = require("https");

// 统一将所有生成的文件存放在 .npm 目录下
const npmDir = path.join(__dirname, '.npm');
if (!fs.existsSync(npmDir)) {
    fs.mkdirSync(npmDir, { recursive: true });
}

const singBoxPath = path.join(npmDir, 'sing-box');
const configPath = path.join(npmDir, 'config.json');
const certPath = path.join(npmDir, 'cert.pem');
const keyPath = path.join(npmDir, 'key.pem');
const pwdPath = path.join(npmDir, 'pwd.txt');           // 密码持久化文件路径
const uuidPath = path.join(npmDir, 'uuid.txt');         // VMess UUID 持久化文件
const wsPathFile = path.join(npmDir, 'wspath.txt');     // VMess WS 路径持久化文件
const cloudflaredPath = path.join(npmDir, 'cloudflared'); // cloudflared 二进制路径

// 把容器分配给你的端口号替换掉 3000
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

/* =========================================================================
 *  Argo / Cloudflare Tunnel 参数
 *  ------------------------------------------------------------------
 *  ARGO_AUTH  : 固定隧道的 Token（Cloudflare Network -> Tunnels 里获取）
 *  ARGO_PORT  : VMess+WS 本地监听端口（同时也是 cloudflared 回源的端口）
 *  ARGO_DOMAIN: 可选，固定隧道绑定的自定义域名，仅用于打印分享链接
 *
 *  逻辑：
 *    ARGO_AUTH + ARGO_PORT  -> 固定隧道
 *    只有 ARGO_PORT         -> 临时隧道（trycloudflare）
 *    两个都没填             -> 不下载 cloudflared、不启动隧道、不启用 vmess 节点
 *
 *  回源协议说明（重要）：
 *    cloudflared -> 本地 sing-box 走的是【明文 HTTP】，不是 HTTPS。
 *    因为这一段只有 localhost 流量，自签证书既不被客户端看见（客户端看到的是
 *    Cloudflare 边缘证书），又要靠 --no-tls-verify 跳过校验，纯属装饰。
 *    自签证书现在只服务于 hysteria2（那是直连，TLS 是真实有效的）。
 *
 *    因此固定隧道面板里的 Service 必须填 http://127.0.0.1:ARGO_PORT。
 * ========================================================================= */
const ARGO_AUTH = (process.env.ARGO_AUTH || '').trim();
const ARGO_PORT = process.env.ARGO_PORT ? parseInt(process.env.ARGO_PORT, 10) : null;
const ARGO_DOMAIN = (process.env.ARGO_DOMAIN || '').trim();

const ENABLE_VMESS = !!ARGO_PORT;                     // 有端口才启用 vmess+ws
const FIXED_TUNNEL = ENABLE_VMESS && !!ARGO_AUTH;     // 有 token 才走固定隧道

// 进程句柄（用于优雅退出）
let singBoxProcess = null;
let cloudflaredProcess = null;

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

// 下载文件的辅助函数
async function downloadFile(url, dest, label) {
    console.log(`[Info] 正在下载 ${label} ...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: ${res.statusText}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buffer);
    console.log(`[Info] ${label} 下载完成。`);
}

// 生成 VMess 分享链接（v2rayN / v2rayNG / sing-box 客户端通用）
// 注意：tls:"tls" 指的是【客户端 -> Cloudflare 边缘】这一段，
//       由 Cloudflare 用其公开可信证书终止，跟本地自签证书无关。
function buildVmessLink(domain, uuid, wsPath, remark) {
    const vmessObj = {
        v: "2",
        ps: remark,
        add: domain,
        port: "443",
        id: uuid,
        aid: "0",
        scy: "auto",
        net: "ws",
        type: "none",
        host: domain,
        path: wsPath,
        tls: "tls",
        sni: domain,
        alpn: "",
        fp: ""
    };
    return "vmess://" + Buffer.from(JSON.stringify(vmessObj)).toString("base64");
}

async function main() {
    try {
        const publicIp = await getPublicIP();

        // 1. 检查并下载 sing-box v1.11.4
        if (!fs.existsSync(singBoxPath)) {
            const downloadUrl = 'https://github.com/SagerNet/sing-box/releases/download/v1.11.4/sing-box-1.11.4-linux-amd64.tar.gz';
            const tarPath = path.join(npmDir, 'sing-box.tar.gz');

            await downloadFile(downloadUrl, tarPath, 'sing-box v1.11.4');

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

        // 2. 检查并生成自签 TLS 证书
        //    现在这份证书只给 hysteria2 用（直连场景，TLS 真实生效）
        if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
            console.log('[Info] 正在生成自签 TLS 证书（供 hysteria2 使用）...');
            execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 3650 -nodes -subj "/CN=bing.com"`, { stdio: 'inherit' });
            console.log('[Info] TLS 证书生成完毕。');
        }

        // 3. 自动计算自签证书的 SHA-256 指纹（适配最新 v2rayN）
        const certContent = fs.readFileSync(certPath);
        const x509 = new X509Certificate(certContent);
        // 转换为 64 位小写十六进制字符串（v2rayN 和 sing-box 标准要求）
        const pinSHA256 = x509.fingerprint256.replace(/:/g, '').toLowerCase();

        // 4. 检查密码文件：首次运行生成并写入，重启复用已有密码
        let password;
        if (fs.existsSync(pwdPath)) {
            password = fs.readFileSync(pwdPath, 'utf8').trim();
            console.log('[Info] 检测到已存在的密码，已成功复用。');
        } else {
            password = crypto.randomBytes(16).toString('hex');
            fs.writeFileSync(pwdPath, password, 'utf8');
            console.log('[Info] 首次运行，已生成新密码并写入 .npm/pwd.txt。');
        }

        // 5. 若启用隧道：准备 VMess UUID 与 WS 路径（持久化，重启复用）
        let vmessUuid = null;
        let wsPath = null;
        if (ENABLE_VMESS) {
            if (fs.existsSync(uuidPath)) {
                vmessUuid = fs.readFileSync(uuidPath, 'utf8').trim();
                console.log('[Info] 检测到已存在的 VMess UUID，已成功复用。');
            } else {
                vmessUuid = crypto.randomUUID();
                fs.writeFileSync(uuidPath, vmessUuid, 'utf8');
                console.log('[Info] 已生成新的 VMess UUID 并写入 .npm/uuid.txt。');
            }

            if (fs.existsSync(wsPathFile)) {
                wsPath = fs.readFileSync(wsPathFile, 'utf8').trim();
                console.log('[Info] 检测到已存在的 WS 路径，已成功复用。');
            } else {
                wsPath = '/' + crypto.randomBytes(8).toString('hex');
                fs.writeFileSync(wsPathFile, wsPath, 'utf8');
                console.log('[Info] 已生成新的 WS 路径并写入 .npm/wspath.txt。');
            }
        }

        // 6. 编写 sing-box 配置文件 (v1.11.4 语法标准)
        const inbounds = [
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
        ];

        // 仅在填写了 ARGO_PORT 时追加 VMess+WS 入站
        if (ENABLE_VMESS) {
            inbounds.push({
                type: 'vmess',
                tag: 'vmess-ws-in',
                listen: '::',
                listen_port: ARGO_PORT,
                users: [
                    {
                        name: 'bot-user',
                        uuid: vmessUuid,
                        alterId: 0
                    }
                ],
                transport: {
                    type: 'ws',
                    path: wsPath,
                    max_early_data: 2048,
                    early_data_header_name: 'Sec-WebSocket-Protocol'
                }
            });
        }

        const config = {
            log: {
                disabled: true,
                level: 'panic',
                timestamp: true
            },
            inbounds: inbounds,
            outbounds: [
                {
                    type: 'direct',
                    tag: 'direct'
                }
            ]
        };

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`[Info] 配置文件已写入: ${configPath}`);

        // 7. 需要隧道时才下载 cloudflared 二进制
        if (ENABLE_VMESS && !fs.existsSync(cloudflaredPath)) {
            const cfUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
            await downloadFile(cfUrl, cloudflaredPath, 'cloudflared');
            execSync(`chmod +x "${cloudflaredPath}"`);
            console.log('[Info] cloudflared 安装并授权成功。');
        } else if (ENABLE_VMESS) {
            console.log('[Info] 检测到 cloudflared 已存在，跳过下载。');
        } else {
            console.log('[Info] 未填写 ARGO_PORT，跳过 cloudflared 下载与隧道启动。');
        }

        // 8. 打印 Hysteria 2 节点信息
        console.log('\n==================== Hysteria 2 节点配置信息 ====================');
        console.log(`监听端口 (Port): ${PORT}`);
        console.log(`认证密码 (Password): ${password}`);
        console.log(`SNI / 伪装域名: bing.com`);
        console.log(`证书指纹 (pinSHA256): ${pinSHA256}`);
        console.log('\n--- 🔗 适配新版 v2rayN 的分享链接 (请将 <你的域名或IP> 替换为实际地址) ---');
        console.log(`hysteria2://${password}@${publicIp}:${PORT}?sni=bing.com&pinSHA256=${pinSHA256}#Bot-Hy2`);
        console.log('=================================================================\n');

        // 9. 启动 sing-box 进程
        console.log('[Info] 正在启动 sing-box 服务...');
        singBoxProcess = spawn(singBoxPath, ['run', '-c', configPath], {
            stdio: 'inherit'
        });

        singBoxProcess.on('close', (code) => {
            console.log(`[Warning] sing-box 进程已退出，退出码: ${code}`);
            if (cloudflaredProcess) {
                try { cloudflaredProcess.kill('SIGTERM'); } catch (_) {}
            }
            process.exit(code);
        });

        // 10. 启动 cloudflared 隧道（仅 ENABLE_VMESS 时）
        if (ENABLE_VMESS) {
            let argoDomain = ARGO_DOMAIN || '';
            let linkPrinted = false;

            const printVmessInfo = (domain) => {
                if (linkPrinted) return;
                linkPrinted = true;
                console.log('\n==================== VMess + WS 节点配置信息 ====================');
                console.log(`隧道模式   : ${FIXED_TUNNEL ? '固定隧道 (Token)' : '临时隧道 (trycloudflare)'}`);
                console.log(`本地端口   : ${ARGO_PORT}（回源协议: http）`);
                console.log(`UUID       : ${vmessUuid}`);
                console.log(`WS 路径    : ${wsPath}`);
                console.log(`域名 / SNI : ${domain}`);
                console.log('\n--- 🔗 分享链接（v2rayN / v2rayNG / sing-box）---');
                console.log(buildVmessLink(domain, vmessUuid, wsPath, 'Bot-VMess-WS'));
                if (FIXED_TUNNEL) {
                    console.log('\n[提示] 固定隧道需要在 Cloudflare Zero Trust 面板把 Public Hostname');
                    console.log(`       的 Service 指向 http://127.0.0.1:${ARGO_PORT}`);
                    console.log('       （用 http 时，No TLS Verify 勾不勾都不影响；');
                    console.log('         若沿用旧的 https 配置且未勾选，会因证书校验失败而回源报错）');
                }
                console.log('=================================================================\n');
            };

            const cfArgs = FIXED_TUNNEL
                ? [
                    'tunnel', '--no-autoupdate',
                    '--edge-ip-version', 'auto',
                    'run', '--token', ARGO_AUTH
                ]
                : [
                    'tunnel', '--no-autoupdate',
                    '--edge-ip-version', 'auto',
                    '--url', `http://127.0.0.1:${ARGO_PORT}`
                ];

            console.log(`[Info] 正在启动 cloudflared ${FIXED_TUNNEL ? '固定' : '临时'}隧道...`);
            cloudflaredProcess = spawn(cloudflaredPath, cfArgs, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            const handleCfOutput = (chunk) => {
                const text = chunk.toString();
                process.stdout.write(`[cloudflared] ${text}`);

                if (!FIXED_TUNNEL) {
                    // 从临时隧道日志中抓取 trycloudflare 域名
                    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
                    if (m) {
                        argoDomain = m[0].replace('https://', '');
                        printVmessInfo(argoDomain);
                    }
                }
            };

            cloudflaredProcess.stdout.on('data', handleCfOutput);
            cloudflaredProcess.stderr.on('data', handleCfOutput);

            cloudflaredProcess.on('close', (code) => {
                console.log(`[Warning] cloudflared 进程已退出，退出码: ${code}`);
            });

            cloudflaredProcess.on('error', (err) => {
                console.error('[Error] cloudflared 启动失败:', err);
            });

            if (FIXED_TUNNEL) {
                // 固定隧道域名由用户提供，启动后延时打印
                setTimeout(() => printVmessInfo(argoDomain || '<你的固定隧道域名>'), 3000);
            }
        }

    } catch (err) {
        console.error('[Error] 运行过程中发生错误:', err);
        process.exit(1);
    }
}

// 优雅退出
function cleanup() {
    try { if (cloudflaredProcess) cloudflaredProcess.kill('SIGTERM'); } catch (_) {}
    try { if (singBoxProcess) singBoxProcess.kill('SIGTERM'); } catch (_) {}
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

main();
