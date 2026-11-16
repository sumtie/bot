编写index.js和package.json，

axios下载https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-64.zip，防止OOM

axios下载cloudflared最新版，防止OOM

tar/unzip解压 部署在nodejs主机上，只考虑linux系统amd64和arm64。

部署hysteria2节点，brutal模式，上下行带宽100MB，HY2_PORT默认8443，密码随机生成，selfsigned库自签证书，计算证书sha-256，节点协议链接带上SHA-256，证书指纹格式要这种61:BC:FD:70:...，。

增加部署vless+xhttp搭配cloudflared固定隧道节点，uuid随机生成，ARGO_TOKEN有填写就启用节点，否则不启用不下载cloudflared，ARGO_PORT默认8080，ARGO_DOMAIN默认为yourArgo.com，XHTTPPATH随机生成

密码、uuid、XHTTPPATH存到.npm/state.json里面，重启可复用

节点协议链接存到.npm/links.txt

index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，

简洁代码