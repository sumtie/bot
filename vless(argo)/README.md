
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
