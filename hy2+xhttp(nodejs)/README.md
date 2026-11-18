注意：默认开启hy2节点，端口号为8443，换成你自己服务器的端口号，argoToken有填写才开启 xhttp argo 隧道节点。

Gemini提示词
```
编写index.js、package.json，

fetch 下载 https://github.com/sumtie/files/releases/download/261109/xray-linux-amd64 | https://github.com/sumtie/files/releases/download/261109/xray-linux-arm64，防止OOM

fetch 下载cloudflared最新版，防止OOM

部署在nodejs主机上，只考虑linux系统amd64和arm64。

部署hysteria2节点(xray本身支持，无需额外下载hysteria二进制)，brutal模式，上行宽带120MB，下行带宽100MB，HY2_PORT默认0不启用，密码随机生成，

selfsigned库自签证书，计算证书sha-256，节点协议链接带上SHA-256，证书指纹格式要这种61:BC:FD:70:...，。

增加部署vless+xhttp搭配cloudflared固定隧道节点，uuid随机生成，ARGO_TOKEN有填写就启用节点，否则不启用不下载cloudflared，ARGO_PORT默认8080，ARGO_DOMAIN默认为空字符串，XHTTPPATH随机生成

密码、uuid、XHTTPPATH存到.npm/state.json里面，重启可复用

节点协议链接存到.npm/links.txt

index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，

按照最新的https://xtls.github.io/文档来写

SHOW_LOG 变量为true，xray和argo日志正常显示，为false关闭xray和argo日志

简洁代码
```
