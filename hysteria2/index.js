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
const pwdPath = path.join(npmDir, 'pwd.txt'); // 密码持久化文件路径

// 把容器分配给你的端口号替换掉 3000
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

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
async function downloadFile(url, dest) {
    console.log(`[Info] 正在从官方下载 sing-box v1.11.4...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: ${res.statusText}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buffer);
    console.log('[Info] 下载完成。');
}

async function main() {
    try {
        const publicIp = await getPublicIP();
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

        // 2. 检查并生成自签 TLS 证书
        if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
            console.log('[Info] 正在生成自签 TLS 证书...');
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

        // 5. 编写 sing-box 配置文件 (v1.11.4 语法标准)
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

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`[Info] 配置文件已写入: ${configPath}`);

        // 6. 打印完美适配最新 v2rayN 的连接参数与分享链接
        console.log('\n==================== Hysteria 2 节点配置信息 ====================');
        console.log(`监听端口 (Port): ${PORT}`);
        console.log(`认证密码 (Password): ${password}`);
        console.log(`SNI / 伪装域名: bing.com`);
        console.log(`证书指纹 (pinSHA256): ${pinSHA256}`);
        console.log('\n--- 🔗 适配新版 v2rayN 的分享链接 (请将 <你的域名或IP> 替换为实际地址) ---');
        console.log(`hysteria2://${password}@${publicIp}:${PORT}?sni=bing.com&insecure=1&pinSHA256=${pinSHA256}#Bot-Hy2`);
        console.log('=================================================================\n');

        // 7. 启动 sing-box 进程
        console.log('[Info] 正在启动 sing-box 服务...');
        const singBoxProcess = spawn(singBoxPath, ['run', '-c', configPath], {
            stdio: 'inherit'
        });

        singBoxProcess.on('close', (code) => {
            console.log(`[Warning] sing-box 进程已退出，退出码: ${code}`);
            process.exit(code);
        });

    } catch (err) {
        console.error('[Error] 运行过程中发生错误:', err);
        process.exit(1);
    }
}

main();
