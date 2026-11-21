
```
编写nodejs代码index.js和package.json

fetch 流式下载https://github.com/Itsusinn/tuic/releases/download/v1.4.5/tuic-server-x86_64-linux，防止OOM

部署在nodejs主机上，只考虑linux系统amd64和arm64。

部署tuic节点，端口默认8443，密码随机生成，uuid随机生成

openssl库自签证书，计算证书sha-256，节点带上SHA-256，证书指纹格式要这种61:BC:FD:70:...，。

index.js同目录下创建.npm文件夹，二进制、节点链接等文件统一放进去，

密码、uuid存到.npm/state.json里面，重启可复用

SHOW_LOG变量为true，tuic日志正常显示，为false关闭日志

简洁代码
```