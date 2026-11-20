注意：临时隧道不支持xhttp，只能使用固定隧道。也就是必须有域名(免费域名也可以)托管在cloudflare上面，创建固定隧道Tunnel来使用。

部分平台开隧道会炸内存，即OOM，能否开隧道，需要测试开了隧道后，下载 Ubuntu iso，然后观察运行内存和cpu情况。

这个代码最好运行内存有512MB以上的服务器，实测过程中，下载文件3分钟，运行内存飙到~298MB

提示词
```
给xray、cloudflared加GOMEMLIMIT和gc，适合ram为256MB的主机。编写index.js，

fetch 流式下载 https://github.com/sumtie/files/releases/download/261109/xray-linux-amd64 | https://github.com/sumtie/files/releases/download/261109/xray-linux-arm64，防止OOM

fetch 流式下载cloudflared最新版，防止OOM

部署在nodejs主机上，只考虑linux系统amd64和arm64。

部署hysteria2节点(xray本身支持，无需额外下载hysteria二进制)，brutal模式，上行宽带120MB，下行带宽100MB，HY2_PORT默认0不启用，密码随机生成

openssl库自签证书，计算证书sha-256，节点协议链接带上SHA-256，证书指纹格式要这种61:BC:FD:70:...，。

增加部署搭配cloudflared固定隧道节点，uuid随机生成，ARGO_TOKEN有填写就启用固定隧道vless+xhttp节点，没有填写就启用vless+ws临时隧道节点，ARGO_PORT默认8080，ARGO_DOMAIN默认为空字符串，XHTTPPATH/WSPATH随机生成

密码、uuid、XHTTPPATH/WSPATH存到.npm/state.json里面，重启可复用

节点协议链接存到.npm/links.txt

index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去

按照最新的https://xtls.github.io/文档来写

SHOW_LOG 变量为true，xray和argo日志正常显示，为false关闭xray和argo日志

简洁代码
```