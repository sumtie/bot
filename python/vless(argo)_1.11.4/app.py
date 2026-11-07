#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py — VLESS + WebSocket over Cloudflare Tunnel (Argo)

目录结构（全部位于脚本同级）：
    app.py
    requirements.txt
    .cache/
        bin/sing-box        sing-box 1.11.4
        bin/cloudflared     cloudflared
        config.json         sing-box 配置
        uuid.txt            UUID（重启复用）
        path.txt            WS 路径（重启复用）
        node.txt            节点链接
        logs/app.log

环境变量：
    ARGO_PORT     本地 WS 监听端口，默认 8080
    ARGO_TOKEN    Cloudflare 隧道 token，填了走固定隧道
    ARGO_DOMAIN   固定隧道的域名（可选）
    UUID          强制指定 UUID（可选）
    WS_PATH       强制指定 WS 路径（可选）
    SING_BOX_VER  sing-box 版本，默认 1.11.4

启动：python app.py
"""

import json
import os
import random
import re
import shutil
import signal
import socket
import string
import subprocess
import sys
import tarfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

try:
    import requests
except Exception:  # 没装 requests 时退回标准库
    requests = None


# --------------------------------------------------------------------------- #
# 基础路径 / 参数
# --------------------------------------------------------------------------- #
BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / ".cache"
BIN_DIR = CACHE_DIR / "bin"
LOG_DIR = CACHE_DIR / "logs"
LOG_FILE = LOG_DIR / "app.log"

CONFIG_FILE = CACHE_DIR / "config.json"
UUID_FILE = CACHE_DIR / "uuid.txt"
PATH_FILE = CACHE_DIR / "path.txt"
NODE_FILE = CACHE_DIR / "node.txt"


def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        val = int(raw)
        return val if 1 <= val <= 65535 else default
    except ValueError:
        return default


SING_BOX_VER = (os.environ.get("SING_BOX_VER") or "1.11.4").strip() or "1.11.4"
ARGO_PORT = _env_int("ARGO_PORT", 8080)
ARGO_TOKEN = (os.environ.get("ARGO_TOKEN") or "").strip()
ARGO_DOMAIN = (os.environ.get("ARGO_DOMAIN") or "").strip()

UA = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

STOP = threading.Event()
_LOG_LOCK = threading.Lock()
_PROCS = {}
_STATE = {"domain": "", "port": ARGO_PORT, "link": ""}


# --------------------------------------------------------------------------- #
# 日志
# --------------------------------------------------------------------------- #
def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    with _LOG_LOCK:
        try:
            print(line, flush=True)
        except Exception:
            pass
        try:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            with open(LOG_FILE, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# 持久化
# --------------------------------------------------------------------------- #
def prepare_dirs() -> None:
    for d in (CACHE_DIR, BIN_DIR, LOG_DIR):
        d.mkdir(parents=True, exist_ok=True)


def load_or_create_uuid() -> str:
    forced = (os.environ.get("UUID") or "").strip()
    if forced:
        UUID_FILE.write_text(forced + "\n", encoding="utf-8")
        return forced
    if UUID_FILE.exists():
        cached = UUID_FILE.read_text(encoding="utf-8").strip()
        if cached:
            return cached
    value = str(uuid.uuid4())
    UUID_FILE.write_text(value + "\n", encoding="utf-8")
    try:
        UUID_FILE.chmod(0o600)
    except Exception:
        pass
    log("已生成新的 UUID 并写入 .cache/uuid.txt")
    return value


def load_or_create_path() -> str:
    forced = (os.environ.get("WS_PATH") or "").strip()
    if forced:
        path = forced if forced.startswith("/") else "/" + forced
        PATH_FILE.write_text(path + "\n", encoding="utf-8")
        return path
    if PATH_FILE.exists():
        cached = PATH_FILE.read_text(encoding="utf-8").strip()
        if cached:
            return cached
    alphabet = string.ascii_lowercase + string.digits
    path = "/" + "".join(random.choices(alphabet, k=12))
    PATH_FILE.write_text(path + "\n", encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# 下载 / 解压（纯 Python）
# --------------------------------------------------------------------------- #
def http_get(url: str, dest: Path, retries: int = 4, timeout: int = 120) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            if requests is not None:
                with requests.get(
                    url, stream=True, timeout=timeout, headers=UA, allow_redirects=True
                ) as resp:
                    resp.raise_for_status()
                    with open(tmp, "wb") as fh:
                        for chunk in resp.iter_content(1 << 16):
                            if chunk:
                                fh.write(chunk)
            else:
                req = urllib.request.Request(url, headers=UA)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    with open(tmp, "wb") as fh:
                        shutil.copyfileobj(resp, fh)
            if tmp.stat().st_size == 0:
                raise RuntimeError("文件为空")
            tmp.replace(dest)
            return dest
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            log(f"下载失败 ({attempt}/{retries}): {url} -> {exc}")
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass
            if attempt < retries:
                time.sleep(min(2 * attempt, 10))
    raise RuntimeError(f"无法下载 {url}: {last_err}")


def extract_tar_gz(archive: Path, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tf:
        try:
            tf.extractall(dest_dir, filter="data")
        except TypeError:
            tf.extractall(dest_dir)


def detect_arch() -> str:
    machine = (os.uname().machine if hasattr(os, "uname") else "x86_64").lower()
    table = {
        "x86_64": "amd64", "amd64": "amd64",
        "aarch64": "arm64", "arm64": "arm64",
        "armv7l": "armv7", "armv7": "armv7", "armv6l": "armv7",
        "i386": "386", "i686": "386", "x86": "386",
        "s390x": "s390x", "riscv64": "riscv64",
    }
    return table.get(machine, "amd64")


def github_asset_url(repo: str, tag: str, pattern: str, exclude=("-musl", "-purego", "-legacy")) -> str:
    api = f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
    try:
        req = urllib.request.Request(api, headers={**UA, "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        regex = re.compile(pattern)
        for asset in data.get("assets", []):
            name = asset.get("name", "")
            if regex.search(name) and not any(x in name for x in exclude):
                return asset["browser_download_url"]
    except Exception as exc:  # noqa: BLE001
        log(f"GitHub API 查询失败: {exc}")
    raise RuntimeError(f"未能在 {repo}@{tag} 中找到匹配 {pattern} 的资源")


# --------------------------------------------------------------------------- #
# sing-box
# --------------------------------------------------------------------------- #
def singbox_binary() -> Path:
    return BIN_DIR / "sing-box"


def singbox_version_ok(binary: Path) -> bool:
    try:
        out = subprocess.run(
            [str(binary), "version"], capture_output=True, text=True, timeout=20
        )
        return SING_BOX_VER in (out.stdout + out.stderr)
    except Exception:
        return False


def install_singbox() -> Path:
    target = singbox_binary()
    if target.exists() and singbox_version_ok(target):
        target.chmod(0o755)
        log(f"sing-box {SING_BOX_VER} 已就绪，跳过下载")
        return target

    if target.exists():
        log("已存在的 sing-box 版本不符，重新下载")
        target.unlink(missing_ok=True)

    arch = detect_arch()
    asset = f"sing-box-{SING_BOX_VER}-linux-{arch}.tar.gz"
    direct = (
        f"https://github.com/SagerNet/sing-box/releases/download/"
        f"v{SING_BOX_VER}/{asset}"
    )
    archive = CACHE_DIR / asset
    log(f"下载 sing-box {SING_BOX_VER} ({arch}) ...")
    try:
        http_get(direct, archive)
    except Exception:
        url = github_asset_url(
            "SagerNet/sing-box", f"v{SING_BOX_VER}", rf"sing-box-{re.escape(SING_BOX_VER)}-linux-{arch}"
        )
        http_get(url, archive)

    tmp_dir = CACHE_DIR / "tmp-singbox"
    shutil.rmtree(tmp_dir, ignore_errors=True)
    extract_tar_gz(archive, tmp_dir)

    found = None
    for item in tmp_dir.rglob("sing-box"):
        if item.is_file():
            found = item
            break
    if not found:
        raise RuntimeError("压缩包内未找到 sing-box 可执行文件")

    shutil.copy2(found, target)
    target.chmod(0o755)
    shutil.rmtree(tmp_dir, ignore_errors=True)
    archive.unlink(missing_ok=True)

    if not singbox_version_ok(target):
        raise RuntimeError("sing-box 安装校验失败")
    log("sing-box 安装完成")
    return target


# --------------------------------------------------------------------------- #
# cloudflared
# --------------------------------------------------------------------------- #
def cloudflared_binary() -> Path:
    return BIN_DIR / "cloudflared"


def cloudflared_ok(binary: Path) -> bool:
    try:
        out = subprocess.run(
            [str(binary), "--version"], capture_output=True, text=True, timeout=20
        )
        return "cloudflared" in (out.stdout + out.stderr).lower()
    except Exception:
        return False


def install_cloudflared() -> Path:
    target = cloudflared_binary()
    if target.exists() and cloudflared_ok(target):
        target.chmod(0o755)
        log("cloudflared 已就绪，跳过下载")
        return target

    target.unlink(missing_ok=True)
    arch = detect_arch()
    cf_arch = "arm" if arch == "armv7" else arch
    name = f"cloudflared-linux-{cf_arch}"
    url = f"https://github.com/cloudflare/cloudflared/releases/latest/download/{name}"

    log(f"下载 cloudflared ({cf_arch}) ...")
    tmp = CACHE_DIR / name
    try:
        http_get(url, tmp)
    except Exception:
        url = github_asset_url(
            "cloudflare/cloudflared", "latest", rf"^{re.escape(name)}$", exclude=(".deb", ".rpm", ".exe", ".asc")
        )
        http_get(url, tmp)

    shutil.copy2(tmp, target)
    target.chmod(0o755)
    tmp.unlink(missing_ok=True)

    if not cloudflared_ok(target):
        raise RuntimeError("cloudflared 安装校验失败")
    log("cloudflared 安装完成")
    return target


# --------------------------------------------------------------------------- #
# 端口
# --------------------------------------------------------------------------- #
def pick_port(preferred: int) -> int:
    candidates = [preferred] + [p for p in range(preferred + 1, min(preferred + 80, 65535))]
    for port in candidates:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return preferred


# --------------------------------------------------------------------------- #
# 配置 / 链接
# --------------------------------------------------------------------------- #
def write_config(port: int, user_uuid: str, ws_path: str) -> None:
    config = {
        "log": {"level": "info", "timestamp": True},
        "inbounds": [
            {
                "type": "vless",
                "tag": "vless-ws-in",
                "listen": "127.0.0.1",
                "listen_port": port,
                "users": [{"name": "user", "uuid": user_uuid, "flow": ""}],
                "transport": {
                    "type": "ws",
                    "path": ws_path,
                    "max_early_data": 2048,
                    "early_data_header_name": "Sec-WebSocket-Protocol",
                },
            }
        ],
        "outbounds": [
            {"type": "direct", "tag": "direct"},
            {"type": "block", "tag": "block"},
        ],
        "route": {"final": "direct"},
    }
    CONFIG_FILE.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"配置已写入 {CONFIG_FILE}")


def build_link(host: str, user_uuid: str, ws_path: str, port: int = 443) -> str:
    params = [
        ("encryption", "none"),
        ("security", "tls"),
        ("sni", host),
        ("fp", "chrome"),
        ("alpn", "h3"),
        ("type", "ws"),
        ("host", host),
        ("path", ws_path),
    ]
    query = "&".join(f"{k}={urllib.parse.quote(str(v), safe='')}" for k, v in params)
    remark = urllib.parse.quote(f"CF-WS-{host}")
    return f"vless://{user_uuid}@{host}:{port}?{query}#{remark}"


def publish_link(host: str) -> None:
    user_uuid = UUID_FILE.read_text(encoding="utf-8").strip()
    ws_path = PATH_FILE.read_text(encoding="utf-8").strip()
    link = build_link(host, user_uuid, ws_path)
    if link == _STATE["link"]:
        return
    _STATE["link"] = link
    try:
        NODE_FILE.write_text(link + "\n", encoding="utf-8")
    except Exception:
        pass

    log("=" * 72)
    log("节点已就绪")
    log(f"  地址   : {host}")
    log(f"  端口   : 443")
    log(f"  UUID   : {user_uuid}")
    log(f"  路径   : {ws_path}")
    log(f"  TLS    : tls / sni={host} / alpn=h3")
    log(f"  链接   : {link}")
    log(f"  已保存 : {NODE_FILE}")
    log("=" * 72)


# --------------------------------------------------------------------------- #
# 进程管理
# --------------------------------------------------------------------------- #
DOMAIN_RE = re.compile(r"https://([a-z0-9][a-z0-9-]*\.trycloudflare\.com)")
HOSTNAME_RE = re.compile(r'"hostname"\s*:\s*"([^"]+)"')


def pump(proc: subprocess.Popen, tag: str) -> None:
    """读取子进程输出，写日志并尝试解析域名。"""
    try:
        for raw in iter(proc.stdout.readline, b""):
            if STOP.is_set():
                pass
            line = raw.decode("utf-8", "replace").rstrip()
            if not line:
                continue
            log(f"[{tag}] {line}")

            if tag != "cloudflared" or _STATE["domain"]:
                continue

            if not ARGO_TOKEN:
                match = DOMAIN_RE.search(line)
                if match:
                    _STATE["domain"] = match.group(1)
                    log(f"临时隧道域名: {_STATE['domain']}")
                    publish_link(_STATE["domain"])
            else:
                match = HOSTNAME_RE.search(line)
                if match and "." in match.group(1):
                    _STATE["domain"] = match.group(1)
                    log(f"从日志解析到域名: {_STATE['domain']}")
                    publish_link(_STATE["domain"])
    except Exception as exc:  # noqa: BLE001
        log(f"[{tag}] 日志读取异常: {exc}")


def spawn(name: str, cmd: list) -> subprocess.Popen:
    log(f"启动 {name}: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
        start_new_session=True,
    )
    _PROCS[name] = proc
    threading.Thread(target=pump, args=(proc, name), daemon=True).start()
    return proc


def stop_proc(name: str) -> None:
    proc = _PROCS.get(name)
    if not proc:
        return
    if proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    _PROCS.pop(name, None)


def start_singbox(port: int) -> None:
    binary = singbox_binary()
    spawn("sing-box", [str(binary), "run", "-c", str(CONFIG_FILE), "--disable-color"])


def start_cloudflared(port: int) -> None:
    binary = cloudflared_binary()
    base = [str(binary), "tunnel", "--no-autoupdate", "--loglevel", "info"]
    if ARGO_TOKEN:
        log("使用固定隧道 (ARGO_TOKEN)")
        cmd = base + ["--edge-ip-version", "auto", "run", "--token", ARGO_TOKEN]
    else:
        log("使用临时隧道 (quick tunnel)")
        cmd = base + ["--edge-ip-version", "auto", "--url", f"http://127.0.0.1:{port}"]
    spawn("cloudflared", cmd)


def wait_domain(timeout: int = 90) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline and not STOP.is_set():
        if _STATE["domain"]:
            return True
        cf = _PROCS.get("cloudflared")
        if cf and cf.poll() is not None:
            log(f"cloudflared 提前退出，返回码 {cf.returncode}")
            return False
        time.sleep(1)
    return bool(_STATE["domain"])


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def shutdown(*_args) -> None:
    if STOP.is_set():
        return
    log("收到退出信号，正在关闭 ...")
    STOP.set()
    for name in ("cloudflared", "sing-box"):
        stop_proc(name)
    log("已退出")
    os._exit(0)


def main() -> int:
    prepare_dirs()
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    log("=" * 72)
    log("VLESS + WS + Cloudflare Tunnel 启动中")
    log(f"模式: {'固定隧道' if ARGO_TOKEN else '临时隧道'}")
    log(f"ARGO_PORT={ARGO_PORT}  ARGO_DOMAIN={ARGO_DOMAIN or '(未填)'}")
    log("=" * 72)

    user_uuid = load_or_create_uuid()
    ws_path = load_or_create_path()
    log(f"UUID: {user_uuid}")
    log(f"WS 路径: {ws_path}")

    install_singbox()
    install_cloudflared()

    port = pick_port(ARGO_PORT)
    if port != ARGO_PORT:
        log(f"端口 {ARGO_PORT} 被占用，改用 {port}")
    _STATE["port"] = port

    write_config(port, user_uuid, ws_path)

    # 预检配置
    check = subprocess.run(
        [str(singbox_binary()), "check", "-c", str(CONFIG_FILE)],
        capture_output=True, text=True, timeout=60,
    )
    if check.returncode != 0:
        log(f"配置校验输出: {check.stdout}{check.stderr}")
        raise RuntimeError("sing-box 配置校验失败")
    log("配置校验通过")

    restarts = 0
    while not STOP.is_set():
        try:
            sb = _PROCS.get("sing-box")
            if sb is None or sb.poll() is not None:
                if sb is not None:
                    log(f"sing-box 已退出 (code={sb.returncode})，重启中")
                start_singbox(port)
                time.sleep(2)

            cf = _PROCS.get("cloudflared")
            if cf is None or cf.poll() is not None:
                if cf is not None:
                    log(f"cloudflared 已退出 (code={cf.returncode})，重启中")
                    _STATE["domain"] = ""
                start_cloudflared(port)
                if wait_domain():
                    if ARGO_TOKEN and ARGO_DOMAIN:
                        publish_link(ARGO_DOMAIN)
                    elif ARGO_TOKEN and not _STATE["domain"]:
                        log("固定隧道未解析到域名，请在 ARGO_DOMAIN 中填写已绑定的域名")
                else:
                    restarts += 1
                    log(f"未取得域名，第 {restarts} 次重试")

            # 固定隧道且填写了域名时，确保链接已输出
            if ARGO_TOKEN and ARGO_DOMAIN and _STATE["link"] == "":
                publish_link(ARGO_DOMAIN)
            if ARGO_TOKEN and ARGO_DOMAIN and _STATE["domain"] != ARGO_DOMAIN:
                _STATE["domain"] = ARGO_DOMAIN
                publish_link(ARGO_DOMAIN)
        except Exception as exc:  # noqa: BLE001
            log(f"主循环异常: {exc}")

        STOP.wait(3)

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:  # noqa: BLE001
        log(f"致命错误: {err}")
        import traceback
        log(traceback.format_exc())
        shutdown()
        sys.exit(1)