#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py — VLESS + WebSocket over Cloudflare Tunnel (Argo) + 可选 Hysteria2

目录结构（全部位于脚本同级）：
    app.py
    requirements.txt
    .cache/
        bin/cloudflared
        singbox/<ver>-<variant>/...   sing-box 完整解压目录（含依赖 .so）
        cert/cert.pem  cert/key.pem   自签证书（仅 Hysteria2）
        config.json
        uuid.txt / path.txt / variant.txt
        node.txt
        logs/app.log

环境变量：
    ARGO_PORT     本地 WS 监听端口，默认 8080
    ARGO_TOKEN    Cloudflare 隧道 token，填了走固定隧道
    ARGO_DOMAIN   固定隧道的域名（可选）
    HY2_PORT      Hysteria2 UDP 端口，默认 0（0 或未填则不启用）
    HY2_HOST      Hysteria2 对外地址，留空自动探测公网 IP
    UUID          强制指定 UUID（可选，同时作为 Hysteria2 密码）
    WS_PATH       强制指定 WS 路径（可选）
    SING_BOX_VER  sing-box 版本，默认 1.14.4

启动：python app.py
"""

import base64
import datetime
import hashlib
import ipaddress
import json
import os
import random
import re
import shutil
import signal
import socket
import ssl
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
CERT_DIR = CACHE_DIR / "cert"
LOG_DIR = CACHE_DIR / "logs"
LOG_FILE = LOG_DIR / "app.log"

CONFIG_FILE = CACHE_DIR / "config.json"
UUID_FILE = CACHE_DIR / "uuid.txt"
PATH_FILE = CACHE_DIR / "path.txt"
NODE_FILE = CACHE_DIR / "node.txt"
VARIANT_FILE = CACHE_DIR / "variant.txt"
CERT_FILE = CERT_DIR / "cert.pem"
KEY_FILE = CERT_DIR / "key.pem"


def _env_int(name, default):
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        val = int(raw)
        return val if 1 <= val <= 65535 else default
    except ValueError:
        return default


def _env_port0(name):
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return 0
    try:
        val = int(raw)
    except ValueError:
        return 0
    return val if 1 <= val <= 65535 else 0


SING_BOX_VER = (os.environ.get("SING_BOX_VER") or "1.14.4").strip() or "1.14.4"
ARGO_PORT = _env_int("ARGO_PORT", 8080)
ARGO_TOKEN = (os.environ.get("ARGO_TOKEN") or "").strip()
ARGO_DOMAIN = (os.environ.get("ARGO_DOMAIN") or "").strip()
HY2_PORT = _env_port0("HY2_PORT")
HY2_HOST_ENV = (os.environ.get("HY2_HOST") or "").strip()

UA = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

STOP = threading.Event()
_LOG_LOCK = threading.Lock()
_PROCS = {}
_STATE = {"domain": "", "port": ARGO_PORT, "rt": None, "cf": None,
          "links": "", "hy2_on": False, "hy2_host": "", "pin": ""}


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
    for d in (CACHE_DIR, BIN_DIR, SB_ROOT, CERT_DIR, LOG_DIR):
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
    path = Path(path)
    with open(path, "rb") as fh:
        magic = fh.read(2)
    if magic != b"\x1f\x8b":
        raise RuntimeError(f"{path.name} 不是有效的 gzip 包")
    if path.stat().st_size < 3_000_000:
        raise RuntimeError(f"{path.name} 体积异常: {path.stat().st_size} 字节")


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
    dest = Path(tempfile.mkdtemp(prefix=f"{name}-")) / Path(rt).name
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
        return (proc.returncode == 0 and SING_BOX_VER in out), out
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


def sb_variants(arch):
    musl_ok = arch in {"amd64", "arm64", "armv7", "386", "riscv64", "loong64"}
    order = ["musl"] if musl_ok else []
    order.append("")
    if musl_ok:
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
        else:
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


def udp_port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


# --------------------------------------------------------------------------- #
# 自签证书 / pinSHA256
# --------------------------------------------------------------------------- #
def make_cert_with_cryptography(host):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
    try:
        ipaddress.ip_address(host)
        san = x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(host))])
    except ValueError:
        san = x509.SubjectAlternativeName([x509.DNSName(host)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(san, critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    KEY_FILE.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    CERT_FILE.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def make_cert_with_openssl(host):
    subprocess.run(["openssl", "ecparam", "-genkey", "-name", "prime256v1",
                    "-out", str(KEY_FILE)], check=True, capture_output=True, timeout=60)
    subj = f"/CN={host}"
    san = f"IP:{host}" if re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", host) else f"DNS:{host}"
    subprocess.run(["openssl", "req", "-new", "-x509", "-days", "3650",
                    "-key", str(KEY_FILE), "-out", str(CERT_FILE),
                    "-subj", subj, "-addext", f"subjectAltName={san}"],
                   check=True, capture_output=True, timeout=60)


def ensure_cert(host):
    if CERT_FILE.exists() and KEY_FILE.exists():
        try:
            KEY_FILE.chmod(0o600)
        except Exception:
            pass
        return True
    try:
        make_cert_with_cryptography(host)
        log("自签证书已生成 (cryptography)")
    except Exception as exc:
        log(f"cryptography 生成证书失败: {exc}，尝试 openssl")
        try:
            make_cert_with_openssl(host)
            log("自签证书已生成 (openssl)")
        except Exception as exc2:
            log(f"openssl 生成证书失败: {exc2}")
            return False
    try:
        KEY_FILE.chmod(0o600)
    except Exception:
        pass
    return True


def cert_pin_sha256():
    """证书 DER 的 SHA-256，标准 base64（与 Hysteria2 URI 的 pinSHA256 一致）。"""
    pem = CERT_FILE.read_text(encoding="ascii")
    der = ssl.PEM_cert_to_DER_cert(pem)
    return base64.b64encode(hashlib.sha256(der).digest()).decode("ascii")


def detect_public_ip():
    for url in ("https://api.ipify.org", "https://ipv4.icanhazip.com",
                "https://ifconfig.me/ip"):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=10) as resp:
                ip = resp.read().decode("utf-8", "replace").strip()
            if re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", ip):
                return ip
        except Exception:
            continue
    return ""


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

    if _STATE["hy2_on"]:
        config["inbounds"].append({
            "type": "hysteria2",
            "tag": "hy2-in",
            "listen": "0.0.0.0",
            "listen_port": HY2_PORT,
            "users": [{"name": "user", "password": user_uuid}],
            "ignore_client_bandwidth": True,
            "tls": {
                "enabled": True,
                "alpn": ["h3"],
                "certificate_path": str(CERT_FILE),
                "key_path": str(KEY_FILE),
            },
        })

    CONFIG_FILE.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"配置已写入 {CONFIG_FILE}")


def build_vless_link(host, user_uuid, ws_path, port=443):
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


def build_hy2_link(user_uuid, host, port, pin, sni):
    auth = urllib.parse.quote(user_uuid, safe="")
    query = (f"insecure=1&pinSHA256={urllib.parse.quote(pin, safe='')}"
             f"&sni={urllib.parse.quote(sni, safe='')}")
    remark = urllib.parse.quote(f"HY2-{host}")
    return f"hysteria2://{auth}@{host}:{port}/?{query}#{remark}"


def publish(host):
    user_uuid = UUID_FILE.read_text(encoding="utf-8").strip()
    ws_path = PATH_FILE.read_text(encoding="utf-8").strip()

    lines = [build_vless_link(host, user_uuid, ws_path)]

    if _STATE["hy2_on"]:
        hy2_host = _STATE["hy2_host"]
        sni = hy2_host
        lines.append(build_hy2_link(user_uuid, hy2_host, HY2_PORT, _STATE["pin"], sni))

    blob = "\n".join(lines)
    if blob == _STATE["links"]:
        return
    _STATE["links"] = blob
    try:
        NODE_FILE.write_text(blob + "\n", encoding="utf-8")
    except Exception:
        pass

    log("=" * 72)
    log("节点已就绪")
    log(f"  UUID : {user_uuid}")
    log(f"  WS   : {ws_path}")
    log("")
    log("  [VLESS+WS]")
    log(f"    {lines[0]}")
    if _STATE["hy2_on"]:
        log("")
        log(f"  [Hysteria2]  端口 {HY2_PORT} (UDP)")
        log(f"    pinSHA256 : {_STATE['pin']}")
        log(f"    {lines[1]}")
    log("")
    log(f"  全部链接已保存: {NODE_FILE}")
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
                    publish(_STATE["domain"])
            else:
                match = HOSTNAME_RE.search(line)
                if match and "." in match.group(1):
                    _STATE["domain"] = match.group(1)
                    publish(_STATE["domain"])
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
# Hysteria2 准备
# --------------------------------------------------------------------------- #
def setup_hysteria2():
    if not HY2_PORT:
        log("HY2_PORT 未设置，跳过 Hysteria2")
        return

    log(f"Hysteria2 端口: {HY2_PORT} (UDP)")

    if not udp_port_free(HY2_PORT):
        log(f"UDP 端口 {HY2_PORT} 已被占用，Hysteria2 仍会尝试启动")

    host = HY2_HOST_ENV or detect_public_ip() or ARGO_DOMAIN
    if not host:
        log("无法确定对外地址，请设置 HY2_HOST，Hysteria2 暂不启用")
        return
    if host != HY2_HOST_ENV and not HY2_HOST_ENV:
        log(f"自动探测到对外地址: {host}（可用 HY2_HOST 覆盖）")

    if not ensure_cert(host):
        log("证书生成失败，Hysteria2 暂不启用")
        return

    _STATE["hy2_host"] = host
    _STATE["pin"] = cert_pin_sha256()
    _STATE["hy2_on"] = True
    log(f"Hysteria2 已启用，pinSHA256={_STATE['pin']}")


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
    log(f"ARGO_PORT={ARGO_PORT}  ARGO_DOMAIN={ARGO_DOMAIN or '(未填)'}  HY2_PORT={HY2_PORT or '(关闭)'}")
    log("=" * 72)

    user_uuid = load_or_create_uuid()
    ws_path = load_or_create_path()
    log(f"UUID: {user_uuid}")
    log(f"WS 路径: {ws_path}")

    sb_bin, sb_rt = install_singbox()
    install_cloudflared()
    setup_hysteria2()

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
                    publish(ARGO_DOMAIN)

            if ARGO_TOKEN and ARGO_DOMAIN and _STATE["links"] == "":
                publish(ARGO_DOMAIN)
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