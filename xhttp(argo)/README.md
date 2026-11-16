注意：临时隧道不支持xhttp，只能使用固定隧道。也就是必须有域名(免费域名也可以)托管在cloudflare上面，创建固定隧道Tunnel来使用。

Gemini提示词：
```
编写index.js，

fetch下载https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-64.zip，防止OOM

fetch下载cloudflared最新版，防止OOM

tar解压 部署在nodejs主机上，只考虑linux系统amd64和arm64。

部署vless+xhttp搭配cloudflared固定隧道节点，uuid随机生成，ARGO_TOKEN必须填写，ARGO_PORT默认8080，ARGO_DOMAIN默认为yourArgo.com，XHTTPPATH随机生成

uuid、XHTTPPATH存到.npm/state.json里面，重启可复用

节点协议链接存到.npm/links.txt

index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，

enableLog变量为true，xray和argo日志正常显示，为false关闭日志

简洁代码
```
