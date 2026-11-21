提示词
```
编写nodejs代码index.js，

fetch 流式下载sing-box 1.11.4

部署在nodejs主机上，只考虑linux系统amd64和arm64。

部署hysteria2或tuic节点，端口默认都是0，HY2_PORT填写了端口就启用hysteria2节点，TUIC_PORT填写了端口就启用tuic节点，两个都填写的话不能同一个端口，共用密码(用户填写或随机生成)，UUID随机生成

openssl自签证书，计算证书sha-256，节点协议链接带上SHA-256，证书指纹格式要这种61:BC:FD:70:...，

节点链接存到links.txt，密码、UUID存到state.json里面，重启可复用。

index.js同目录下创建.npm文件夹，二进制、证书等文件、links.txt等文件统一放进去，

SHOW_LOG变量，为true时shoes、argo日志打印，为false时关闭shoes、argo日志

简洁代码。
```