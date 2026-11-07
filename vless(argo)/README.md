
编写nodejs代码，部署在nodejs类主机上，sing-box 1.11.4+cloudflare隧道，搭建vless+ws搭配cloudflare隧道节点，默认端口号ARGO_PORT为8080，如果用户有填写ARGO_TOKEN，就启动固定隧道，否则临时隧道，ARGO_DOMAIN可填可不填写。代码执行过程所有文件放到.npm目录下，uuid重启可复用，尽量简约代码少代码实现。


下面是一份精简实现。核心思路：所有二进制和配置都放在 `.npm` 目录，UUID 保存到文件中以便复用，sing-box 用 VLESS+WS 监听 `ARGO_PORT`（默认 8080），cloudflared 根据有没有 `ARGO_TOKEN` 决定是启动固定隧道还是临时隧道，最后自动输出节点链接。

index.js


部署要点：

- 启动文件填 `index.js`，Node 版本 18 以上（需要 fetch）。
- 环境变量：`ARGO_PORT` 可留空，默认 8080；要固定隧道就填 `ARGO_TOKEN`，同时在 Cloudflare Zero Trust 里给该隧道配置 Public Hostname 指向 `http://127.0.0.1:8080`，再把 `ARGO_DOMAIN` 填成那个主机名。临时隧道则两个都不填，脚本会自己从 cloudflared 输出里抓 `trycloudflare.com` 地址并打印完整节点。
- UUID 存在 `.npm/uuid`，重启直接复用，不会变。
- WS 路径固定 `/vless`，节点链接里已做 URL 编码，客户端直接导入即可。
- 临时隧道的域名每次重启都会变，只有固定隧道才谈得上长期可用；`ARGO_DOMAIN` 只影响打印出来的链接文本，不影响隧道本身。

需要的话可以把 WS 路径也做成环境变量，或者加上 sing-box 的日志轮转控制。


增加hysteria2节点，端口号默认0，如果用户有填写端口号，就启用hysteria2节点，密码复用uuid，自签证书（用nodejs），sni为bing.com，计算证书指纹，节点链接带上证书指纹，证书指纹大概是61:BC:FD:70:06:99:32:78:D5:E3:05:AC:EC:20...


已按你的要求加上 Hysteria2，要点都落到了代码里：

- HY2_PORT 默认 0（关闭），填了合法端口才启用
- 密码直接复用 uuid
- 用 Node 原生 crypto 生成 P-256 自签证书（纯 DER 手工编码，不依赖 openssl）
- SNI 固定 bing.com，证书 SAN 也是 bing.com
- 对 DER 证书做 SHA-256，输出 19:6F:28:... 这种大写冒号格式的指纹，写进链接的 pinSHA256
- 证书/私钥/指纹落盘复用，重启不换指纹
- 新增 HY2_HOST（可选）指定链接里的公网地址，因为 Hysteria2 走 UDP 直连，不能走 Cloudflare 隧道

改动说明：

- HY2_PORT 不填或填 0 时行为与原脚本完全一致，inbounds 里不会出现 hysteria2。
- 端口是 UDP，容器/面板要放行对应的 UDP 端口，TCP 映射对它无效。
- 指纹缓存进 hy2.fp，删掉 hy2.crt / hy2.key / hy2.fp 三件套就会重新签发并换新指纹。
- 链接用 insecure=1 + pinSHA256 双保险，客户端按指纹校验，SNI 为 bing.com，证书自身 CN/SAN 也是 bing.com。

