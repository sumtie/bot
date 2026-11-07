#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py — VLESS + WebSocket over Cloudflare Tunnel (Argo)

目录结构（全部位于脚本同级）：
    app.py
    requirements.txt
    .cache/
        bin/cloudflared
        singbox/<ver>-<variant>/...   sing-box 完整解压目录（含依赖 .so）
        config.json
        uuid.txt / path.txt / variant.txt
        node.txt
        logs/app.log

环境变量：
    ARGO_PORT     本地 WS 监听端口，默认 8080
    ARGO_TOKEN    Cloudflare 隧道 token，填了走固定隧道
    ARGO_DOMAIN   固定隧道的域名（可选）
    UUID          强制指定 UUID（可选）
    WS_PATH       强制指定 WS 路径（可选）
    SING_BOX_VER  sing-box 版本，默认 1.14.4

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
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

try:
    import requests
except Exception:
    requests = None


# --------------------------------------------------------------------------- #
# 基础路径 / 参数
# --------------------------------------------------------------------------- #
BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / ".cache"
BIN_DIR = CACHE_DIR / "bin"
SB_ROOT = CACHE_DIR / "singbox"
LOG_DIR = CACHE_DIR / "logs"
LOG_FILE = LOG_DIR / "app.log"

CONFIG_FILE = CACHE_DIR / "config.json"
UUID_FILE = CACHE_DIR / "uuid.txt"
PATH_FILE = CACHE_DIR / "path.txt"
NODE_FILE = CACHE_DIR / "node.txt"
VARIANT_FILE = CACHE_DIR / "variant.txt"


def _env_int(name, default):
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        val = int(raw)
        return val if 1 <= val <= 65535 else default
    except ValueError:
        return default


SING_BOX_VER = (os.environ.get("SING_BOX_VER") or "1.14.4").strip() or "1.14.4"
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
_STATE = {"domain": "", "port": ARGO_PORT, "link": "", "rt": None}


# --------------------------------------------------------------------------- #
# 日志
# --------------------------------------------------------------------------- #
def log(msg):
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


def prepare_dirs():
    for d in (CACHE_DIR, BIN_DIR, SB_ROOT, LOG_DIR):
        d.mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------- #
# 持久化
# --------------------------------------------------------------------------- #
def load_or_create_uuid():
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


def load_or_create_path():
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
# 下载 / 解压
# --------------------------------------------------------------------------- #
def http_get(url, dest, retries=4, timeout=180):
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            if requests is not None:
                with requests.get(url, stream=True, timeout=timeout,
                                  headers=UA, allow_redirects=True) as resp:
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
        except Exception as exc:
            last_err = exc
            log(f"下载失败 ({attempt}/{retries}): {url} -> {exc}")
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass
            if attempt < retries:
                time.sleep(min(2 * attempt, 10))
    raise RuntimeError(f"无法下载 {url}: {last_err}")


def verify_gzip(path):
    with open(path, "rb") as fh:
        magic = fh.read(2)
    if magic != b"\x1f\x8b":
        raise RuntimeError(f"{path.name} 不是有效的 gzip 包（前两字节 {magic!r}）")
    if Path(path).stat().st_size < 3_000_000:
        raise RuntimeError(f"{path.name} 体积异常: {Path(path).stat().st_size} 字节")


def extract_tar_gz(archive, dest_dir):
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tf:
        try:
            tf.extractall(dest_dir, filter="data")
        except TypeError:
            tf.extractall(dest_dir)


def detect_arch():
    machine = (os.uname().machine if hasattr(os, "uname") else "x86_64").lower()
    table = {
        "x86_64": "amd64", "amd64": "amd64",
        "aarch64": "arm64", "arm64": "arm64",
        "armv7l": "armv7", "armv7": "armv7", "armv6l": "armv6",
        "i386": "386", "i686": "386", "x86": "386",
        "s390x": "s390x", "riscv64": "riscv64", "loongarch64": "loong64",
    }
    return table.get(machine, "amd64")


def github_asset_url(repo, tag, pattern, exclude=("-musl", "-purego", "-legacy")):
    api = f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
    try:
        req = urllib.request.Request(
            api, headers={**UA, "Accept": "application/vnd.github+json"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        regex = re.compile(pattern)
        for asset in data.get("assets", []):
            name = asset.get("name", "")
            if regex.search(name) and not any(x in name for x in exclude):
                return asset["browser_download_url"]
    except Exception as exc:
        log(f"GitHub API 查询失败: {exc}")
    raise RuntimeError(f"未能在 {repo}@{tag} 中找到匹配 {pattern} 的资源")


# --------------------------------------------------------------------------- #
# 执行环境
# --------------------------------------------------------------------------- #
def sb_env(rt):
    env = dict(os.environ)
    prev = env.get("LD_LIBRARY_PATH") or ""
    env["LD_LIBRARY_PATH"] = str(rt) + ((":" + prev) if prev else "")
    return env


def is_exec_error(text):
    low = text.lower()
    return any(k in low for k in ("permission denied", "exec format", "cannot execute",
                                  "not executable", "operation not permitted"))


def relocate_for_exec(rt, name):
    """目录所在卷不可执行时，搬到 /tmp 再跑。"""
    dest = Path(tempfile.mkdtemp(prefix=f"{name}-")) / rt.name
    shutil.copytree(rt, dest)
    for item in dest.rglob("*"):
        if item.is_file():
            try:
                item.chmod(0o755)
            except Exception:
                pass
    log(f"{rt} 无法直接执行，已复制到 {dest}")
    return dest


# --------------------------------------------------------------------------- #
# sing-box
# --------------------------------------------------------------------------- #
def run_sb(binary, rt, args, timeout=60):
    return subprocess.run([str(binary)] + args, cwd=str(rt), env=sb_env(rt),
                          capture_output=True, text=True, timeout=timeout)


def sb_probe(binary, rt):
    try:
        proc = run_sb(binary, rt, ["version"], timeout=30)
        out = ((proc.stdout or "") + (proc.stderr or "")).strip()
        ok = proc.returncode == 0 and SING_BOX_VER in out
        return ok, out
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


def sb_variants(arch):
    musl_ok = arch in {"amd64", "arm64", "armv7", "386", "riscv64", "loong64"}
    glibc_ok = musl_ok
    order = []
    if musl_ok:
        order.append("musl")
    order.append("")            # 通用包
    if glibc_ok:
        order.append("glibc")
    return order


def cached_singbox():
    rt = _STATE.get("rt")
    if rt:
        binary = Path(rt) / "sing-box"
        if binary.exists():
            return binary, Path(rt)
    if VARIANT_FILE.exists():
        raw = VARIANT_FILE.read_text(encoding="utf-8").strip()
        if raw:
            rt = Path(raw)
            binary = rt / "sing-box"
            if binary.exists():
                ok, _ = sb_probe(binary, rt)
                if ok:
                    _STATE["rt"] = str(rt)
                    return binary, rt
    return None, None


def install_singbox():
    hit = cached_singbox()
    if hit[0]:
        log(f"sing-box 已就绪: {hit[0]}")
        return hit

    arch = detect_arch()
    errors = []
    for variant in sb_variants(arch):
        suffix = f"-{variant}" if variant else ""
        asset = f"sing-box-{SING_BOX_VER}-linux-{arch}{suffix}.tar.gz"
        url = (f"https://github.com/SagerNet/sing-box/releases/download/"
               f"v{SING_BOX_VER}/{asset}")
        archive = CACHE_DIR / asset
        tag = variant or "generic"
        log(f"下载 sing-box {SING_BOX_VER} [{tag}] ...")
        try:
            http_get(url, archive)
            verify_gzip(archive)
        except Exception as exc:
            errors.append(f"[{tag}] 下载/校验失败: {exc}")
            archive.unlink(missing_ok=True)
            continue

        work = CACHE_DIR / f"tmp-{tag}"
        shutil.rmtree(work, ignore_errors=True)
        try:
            extract_tar_gz(archive, work)
        except Exception as exc:
            errors.append(f"[{tag}] 解压失败: {exc}")
            shutil.rmtree(work, ignore_errors=True)
            archive.unlink(missing_ok=True)
            continue

        binary = None
        for item in work.rglob("sing-box"):
            if item.is_file():
                binary = item
                break
        if binary is None:
            errors.append(f"[{tag}] 包内没有 sing-box")
            shutil.rmtree(work, ignore_errors=True)
            archive.unlink(missing_ok=True)
            continue

        rt = binary.parent
        for item in rt.rglob("*"):
            if item.is_file():
                try:
                    item.chmod(0o755)
                except Exception:
                    pass
        binary.chmod(0o755)

        ok, out = sb_probe(binary, rt)
        if not ok and is_exec_error(out):
            rt = relocate_for_exec(rt, "singbox")
            binary = rt / "sing-box"
            ok, out = sb_probe(binary, rt)
        if not ok:
            errors.append(f"[{tag}] 无法运行: {out[:400]}")
            log(f"[{tag}] 不可用: {out[:400]}")
            shutil.rmtree(work, ignore_errors=True)
            archive.unlink(missing_ok=True)
            continue

        final_rt = SB_ROOT / f"{SING_BOX_VER}-{arch}{suffix}"
        shutil.rmtree(final_rt, ignore_errors=True)
        if rt.is_relative_to(CACHE_DIR):
            rt.rename(final_rt)
            binary = final_rt / "sing-box"
        else:  # 已在 /tmp
            final_rt = rt
        shutil.rmtree(work, ignore_errors=True)
        archive.unlink(missing_ok=True)

        ok, out = sb_probe(binary, final_rt)
        if not ok:
            errors.append(f"[{tag}] 迁移后失效: {out[:300]}")
            continue

        VARIANT_FILE.write_text(str(final_rt) + "\n", encoding="utf-8")
        _STATE["rt"] = str(final_rt)
        log(f"sing-box 安装完成 [{tag}]: {binary}")
        log(f"版本输出: {out.splitlines()[0] if out else ''}")
        return binary, final_rt

    raise RuntimeError("sing-box 全部构建变体均不可用:\n  " + "\n  ".join(errors))


# --------------------------------------------------------------------------- #
# cloudflared
# --------------------------------------------------------------------------- #
def cloudflared_binary():
    return BIN_DIR / "cloudflared"


def cloudflared_ok(binary):
    try:
        proc = subprocess.run([str(binary), "--version"], capture_output=True,
                              text=True, timeout=30)
        return proc.returncode == 0 and "cloudflared" in (proc.stdout + proc.stderr).lower()
    except Exception:
        return False


def install_cloudflared():
    target = cloudflared_binary()
    if target.exists() and cloudflared_ok(target):
        target.chmod(0o755)
        log("cloudflared 已就绪")
        return target

    target.unlink(missing_ok=True)
    arch = detect_arch()
    cf_arch = "arm" if arch in ("armv7", "armv6") else arch
    name = f"cloudflared-linux-{cf_arch}"
    tmp = CACHE_DIR / name

    log(f"下载 cloudflared ({cf_arch}) ...")
    try:
        http_get(f"https://github.com/cloudflare/cloudflared/releases/latest/download/{name}", tmp)
    except Exception:
        url = github_asset_url("cloudflare/cloudflared", "latest",
                               rf"^{re.escape(name)}$",
                               exclude=(".deb", ".rpm", ".exe", ".asc", ".sha256"))
        http_get(url, tmp)

    shutil.copy2(tmp, target)
    target.chmod(0o755)
    tmp.unlink(missing_ok=True)

    if not cloudflared_ok(target):
        alt = relocate_for_exec(BIN_DIR, "cf")
        target = alt / "cloudflared"
        if not cloudflared_ok(target):
            raise RuntimeError("cloudflared 安装校验失败")
        _STATE["cf"] = str(target)
    log("cloudflared 安装完成")
    return target


def cf_binary():
    cached = _STATE.get("cf")
    if cached and Path(cached).exists():
        return Path(cached)
    return cloudflared_binary()


# --------------------------------------------------------------------------- #
# 端口
# --------------------------------------------------------------------------- #
def pick_port(preferred):
    for port in [preferred] + [p for p in range(preferred + 1, min(preferred + 80, 65535))]:
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
def write_config(port, user_uuid, ws_path):
    config = {
        "log": {"level": "info", "timestamp": True},
        "inbounds": [{
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
        }],
        "outbounds": [
            {"type": "direct", "tag": "direct"},
            {"type": "block", "tag": "block"},
        ],
        "route": {"final": "direct"},
    }
    CONFIG_FILE.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"配置已写入 {CONFIG_FILE}")


def build_link(host, user_uuid, ws_path, port=443):
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
    return f"vless://{user_uuid}@{host}:{port}?{query}#{urllib.parse.quote('CF-WS-' + host)}"


def publish_link(host):
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
    log(f"  地址 : {host}")
    log(f"  端口 : 443")
    log(f"  UUID : {user_uuid}")
    log(f"  路径 : {ws_path}")
    log(f"  TLS  : tls / sni={host} / alpn=h3")
    log(f"  链接 : {link}")
    log(f"  保存 : {NODE_FILE}")
    log("=" * 72)


# --------------------------------------------------------------------------- #
# 进程管理
# --------------------------------------------------------------------------- #
DOMAIN_RE = re.compile(r"https://([a-z0-9][a-z0-9-]*\.trycloudflare\.com)")
HOSTNAME_RE = re.compile(r'"hostname"\s*:\s*"([^"]+)"')


def pump(proc, tag):
    try:
        for raw in iter(proc.stdout.readline, b""):
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
                    publish_link(_STATE["domain"])
            else:
                match = HOSTNAME_RE.search(line)
                if match and "." in match.group(1):
                    _STATE["domain"] = match.group(1)
                    publish_link(_STATE["domain"])
    except Exception as exc:
        log(f"[{tag}] 日志读取异常: {exc}")


def spawn(name, cmd, cwd=None, env=None):
    log(f"启动 {name}")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            bufsize=0, cwd=cwd, env=env, start_new_session=True)
    _PROCS[name] = proc
    threading.Thread(target=pump, args=(proc, name), daemon=True).start()
    return proc


def stop_proc(name):
    proc = _PROCS.pop(name, None)
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


def start_singbox(binary, rt, port):
    spawn("sing-box", [str(binary), "run", "-c", str(CONFIG_FILE), "--disable-color"],
          cwd=str(rt), env=sb_env(rt))


def start_cloudflared(port):
    binary = cf_binary()
    base = [str(binary), "tunnel", "--no-autoupdate", "--loglevel", "info",
            "--edge-ip-version", "auto"]
    if ARGO_TOKEN:
        log("使用固定隧道 (ARGO_TOKEN)")
        spawn("cloudflared", base + ["run", "--token", ARGO_TOKEN])
    else:
        log("使用临时隧道 (quick tunnel)")
        spawn("cloudflared", base + ["--url", f"http://127.0.0.1:{port}"])


def wait_domain(timeout=90):
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
def shutdown(code=0):
    if STOP.is_set():
        return
    log("收到退出信号，正在关闭 ...")
    STOP.set()
    for name in ("cloudflared", "sing-box"):
        stop_proc(name)
    log("已退出")
    os._exit(code)


def main():
    prepare_dirs()
    signal.signal(signal.SIGINT, lambda *_: shutdown(0))
    signal.signal(signal.SIGTERM, lambda *_: shutdown(0))

    log("=" * 72)
    log("VLESS + WS + Cloudflare Tunnel 启动中")
    log(f"模式: {'固定隧道' if ARGO_TOKEN else '临时隧道'}")
    log(f"ARGO_PORT={ARGO_PORT}  ARGO_DOMAIN={ARGO_DOMAIN or '(未填)'}")
    log("=" * 72)

    user_uuid = load_or_create_uuid()
    ws_path = load_or_create_path()
    log(f"UUID: {user_uuid}")
    log(f"WS 路径: {ws_path}")

    sb_bin, sb_rt = install_singbox()
    install_cloudflared()

    port = pick_port(ARGO_PORT)
    if port != ARGO_PORT:
        log(f"端口 {ARGO_PORT} 被占用，改用 {port}")
    _STATE["port"] = port

    write_config(port, user_uuid, ws_path)

    check = run_sb(sb_bin, sb_rt, ["check", "-c", str(CONFIG_FILE)], timeout=60)
    if check.returncode != 0:
        log(f"配置校验输出: {(check.stdout or '') + (check.stderr or '')}")
        raise RuntimeError("sing-box 配置校验失败")
    log("配置校验通过")

    while not STOP.is_set():
        try:
            sb = _PROCS.get("sing-box")
            if sb is None or sb.poll() is not None:
                if sb is not None:
                    log(f"sing-box 已退出 (code={sb.returncode})，重启")
                start_singbox(sb_bin, sb_rt, port)
                time.sleep(2)

            cf = _PROCS.get("cloudflared")
            if cf is None or cf.poll() is not None:
                if cf is not None:
                    log(f"cloudflared 已退出 (code={cf.returncode})，重启")
                _STATE["domain"] = ""
                start_cloudflared(port)
                if not wait_domain():
                    log("未取得域名，稍后重试")
                elif ARGO_TOKEN and ARGO_DOMAIN:
                    _STATE["domain"] = ARGO_DOMAIN
                    publish_link(ARGO_DOMAIN)

            if ARGO_TOKEN and ARGO_DOMAIN and _STATE["link"] == "":
                publish_link(ARGO_DOMAIN)
        except Exception as exc:
            log(f"主循环异常: {exc}")
        STOP.wait(3)


if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        log(f"致命错误: {err}")
        import traceback
        log(traceback.format_exc())
        shutdown(1)