编写nodejs代码，部署在nodejs类主机上，xray v26.10.31+cloudflare隧道，搭建vless+xhttp搭配cloudflare隧道节点，默认端口号ARGO_PORT为8080，必须填写ARGO_TOKEN，启动固定隧道，ARGO_DOMAIN可填可不填写。代码执行过程所有文件放到.npm目录下，.npm与index.js在同一级目录，uuid重启可复用，尽量简约代码少代码实现。



下面是极简实现。核心思路：一个 `index.js` 搞定全部——所有文件落在 `.npm`，UUID 落盘复用，Xray 只监听 `127.0.0.1:ARGO_PORT`（明文 xhttp），cloudflared 用 `ARGO_TOKEN` 起固定隧道把本地端口打出去。节点侧 TLS 由 Cloudflare 边缘终结，所以 Xray 不需要证书。

**package.json**


```json
{
  "name": "argo-xhttp",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": { "start": "node index.js" }
}
```

**index.js**


部署要点：

- 环境变量 `ARGO_TOKEN` 必填（Zero Trust 里已建好的隧道 token）；`ARGO_PORT` 默认 8080；`ARGO_DOMAIN` 可选，填了就直接打印完整可用链接。
- Cloudflare 后台该隧道的 Public Hostname 必须指向 `http://localhost:8080`（或你改的端口），Service 类型选 HTTP。
- 启动命令 `npm start`，主机需允许写入 `.npm` 与外网访问 GitHub。
- 客户端：XHTTP + TLS，`mode=auto`、`path=/`、`sni`/`host` 均为你的域名，SNI 与 Host 必须一致否则 403。

注意事项：`127.0.0.1` 绑定意味着容器外无法直连 8080，全部流量只走隧道，安全但也要求 Cloudflare 侧配置正确；如果主机用 IPv6-only 或 docker 网络特殊，把监听改成 `0.0.0.0` 即可。
