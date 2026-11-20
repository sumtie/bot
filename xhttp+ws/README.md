编写index.js

fetch下载 https://github.com/cfal/shoes/releases/download/v0.3.8/shoes-x86_64-unknown-linux-musl.tar.gz，防止OOM，

fetch下载cloudflared，防止OOM

部署在nodejs主机上，只考虑linux系统amd64和arm64。

部署搭配cloudflared隧道节点，uuid随机生成，ARGO_TOKEN有填写就固定隧道vless+xhttp节点，没有就临时隧道vless+ws节点，ARGO_PORT默认8080，WS_PATH随机生成

uuid、WS_PATH存到.npm/state.json里面，重启可复用

节点协议链接存到.npm/links.txt

index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去

SHOW_LOG变量，为true时shoes、argo日志打印，为false时关闭shoes、argo日志

简洁代码



