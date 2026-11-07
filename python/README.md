编写python代码app.py，部署在python类主机上如bot-hosting.net，sing-box 1.14.4+cloudflare隧道，搭建vless+ws搭配cloudflare隧道节点，默认端口号ARGO_PORT为8080，如果用户有填写ARGO_TOKEN，就启动固定隧道，否则临时隧道，ARGO_DOMAIN可填可不填写。代码执行过程所有文件放到.cache目录下，uuid重启可复用，requests.txt和app.py和.cache目录同级目录，文件下载、解压要用Python的包或者第三方包来操作，尽量完善可用


vless(argo)+hy2_1.14.4 版待测试

