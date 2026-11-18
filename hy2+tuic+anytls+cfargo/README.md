```
编写nodejs代码index.js

curl下载https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-amd64-musl.tar.gz,

tar解压 部署在nodejs主机上，只考虑linux系统amd64和arm64。

部署hysteria2或tuic节点，端口默认都是0，HY2_PORT填写了端口就启用hysteria2节点，TUIC_PORT填写了端口就启用tuic节点，两个都填写的话不能同一个端口，共用密码(用户填写或随机生成)，uuid随机生成

openssl自签证书，计算证书sha-256，节点带上SHA-256，证书指纹格式要这种61:BC:FD:70:...，。

index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，

增加部署anytls节点，端口号可以与hysteria2/tuic共存，密码和hysteria2共用，证书和hysteria2共用

增加部署vless+ws搭配cloudflared隧道节点，uuid和tuicUUID共用，ARGO_TOKEN有填写就固定隧道，没有就临时隧道，ARGO_DOMAIN可填可不填，ARGO_PORT默认8080，WS_PATH随机生成，cloudflared只把日志写到.npm/argo.log，临时隧道域名从.npm/argo.log获取

密码、uuid、WS_PATH存到.npm/state.json里面，重启可复用

以sing-box官方最新文档https://sing-box.sagernet.org/为主，编写代码配置

简洁代码
```
