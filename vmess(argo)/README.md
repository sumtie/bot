编写nodejs代码，部署在nodejs类主机上，sing-box 1.11.4+cloudflare隧道，搭建vmess+ws搭配cloudflare隧道节点，默认端口号ARGO_PORT为8080，如果用户有填写ARGO_TOKEN，就启动固定隧道，否则临时隧道，ARGO_DOMAIN可填可不填写。代码执行过程所有文件放到.npm目录下，uuid重启可复用，尽量简约代码少代码实现。


下面是完整实现，单文件，逻辑尽量精简。核心点：二进制和配置全部落在 `./.npm` 下，UUID 写入文件复用，`ARGO_TOKEN` 存在则走固定隧道，否则起临时隧道并从输出里抓取 `*.trycloudflare.com` 域名。

index.js


要点说明：

- 需要 Node 18+（用到全局 fetch 与 Web Stream），主机能访问 GitHub 和 Cloudflare 边缘。
- `sing-box` 只监听 `127.0.0.1:8080`，外部仅经 cloudflared 进入，不直接暴露端口。
- 首次运行下载 `sing-box 1.11.4` 与 `cloudflared` 到 `.npm`，之后复用；UUID 存 `.npm/uuid.txt`，重启不变。
- 固定隧道时，ingress 的 service 必须指向 `http://127.0.0.1:8080`（或你的 ARGO_PORT），路径与 WS 路径 `/argo` 无关，无需额外配置。
- 若主机网络对 QUIC 不友好、隧道反复重连，可在 cloudflared 参数里加 `--protocol http2` 强制走 HTTP/2。
