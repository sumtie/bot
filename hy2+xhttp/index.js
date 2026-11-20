import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORK_DIR = path.join(__dirname, ".npm");
fs.mkdirSync(WORK_DIR, { recursive: true });

const ARCH = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
if (process.platform !== "linux" || !ARCH) {
  console.error(`Unsupported platform/arch: ${process.platform}/${process.arch}`);
  process.exit(1);
}

const HY2_PORT = Number(process.env.HY2_PORT || 0);
const ARGO_TOKEN = (process.env.ARGO_TOKEN || "").trim();
const ARGO_PORT = Number(process.env.ARGO_PORT || 8080);
const ARGO_DOMAIN = (process.env.ARGO_DOMAIN || "").trim();
const SHOW_LOG = process.env.SHOW_LOG !== "false";
const GO_MEM_LIMIT = process.env.GOMEMLIMIT || "40MiB";
const GO_GC = process.env.GOGC || "50";

const STATE_PATH = path.join(WORK_DIR, "state.json");
const LINKS_PATH = path.join(WORK_DIR, "links.txt");
const XRAY_CONFIG_PATH = path.join(WORK_DIR, "config.json");
const XRAY_BIN = path.join(WORK_DIR, "xray");
const CF_BIN = path.join(WORK_DIR, "cloudflared");
const CERT_PEM = path.join(WORK_DIR, "cert.pem");
const KEY_PEM = path.join(WORK_DIR, "key.pem");

const XRAY_URL =
  ARCH === "arm64"
    ? "https://github.com/sumtie/files/releases/download/261109/mybot-linux-arm64"
    : "https://github.com/sumtie/files/releases/download/261109/mybot-linux-amd64";

const CF_URL =
  ARCH === "arm64"
    ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
    : "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";

function loadOrCreateState() {
  let state = {};
  if (fs.existsSync(STATE_PATH)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    } catch {}
  }
  const next = {
    password: state.password || crypto.randomBytes(16).toString("hex"),
    uuid: state.uuid || crypto.randomUUID(),
    xhttpPath: state.xhttpPath || `/${crypto.randomBytes(6).toString("hex")}`,
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  return next;
}

async function downloadBinary(url, destPath) {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    fs.chmodSync(destPath, 0o755);
    return;
  }
  const tmpPath = `${destPath}.tmp`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  await pipeline(res.body, fs.createWriteStream(tmpPath));
  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, destPath);
}

function ensureSelfSignedCert() {
  if (!fs.existsSync(CERT_PEM) || !fs.existsSync(KEY_PEM)) {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        KEY_PEM,
        "-out",
        CERT_PEM,
        "-days",
        "3650",
        "-subj",
        "/CN=bing.com",
      ],
      { stdio: "ignore" }
    );
  }
  const pem = fs.readFileSync(CERT_PEM);
  const x509 = new crypto.X509Certificate(pem);
  const rawHex = crypto.createHash("sha256").update(x509.raw).digest("hex").toUpperCase();
  const fingerprint = rawHex.match(/.{1,2}/g).join(":");
  return { fingerprint, sni: "bing.com" };
}

function getPublicIp() {
  try {
    return execFileSync("curl", ["-4s", "--max-time", "5", "https://api.ipify.org"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "YOUR_SERVER_IP";
  }
}

function buildXrayConfig(state, certInfo) {
  const inbounds = [];
  const routingRules = [];

  if (HY2_PORT > 0) {
    inbounds.push({
      tag: "hy2-in",
      port: HY2_PORT,
      protocol: "hysteria",
      settings: {
        version: 2,
        clients: [{ password: state.password }],
      },
      streamSettings: {
        network: "hysteria",
        security: "tls",
        tlsSettings: {
          alpn: ["h3"],
          certificates: [{ certificateFile: CERT_PEM, keyFile: KEY_PEM }],
        },
        hysteriaSettings: {
          version: 2,
          udphop: {},
          maxUpstreamMbps: 120,
          maxDownstreamMbps: 100,
          brutal: {
            enabled: true,
            upMbps: 120,
            downMbps: 100,
          },
        },
      },
    });
    routingRules.push({ type: "field", inboundTag: ["hy2-in"], outboundTag: "direct" });
  }

  if (ARGO_TOKEN) {
    inbounds.push({
      tag: "vless-xhttp-in",
      listen: "127.0.0.1",
      port: ARGO_PORT,
      protocol: "vless",
      settings: {
        clients: [{ id: state.uuid }],
        decryption: "none",
      },
      streamSettings: {
        network: "xhttp",
        xhttpSettings: {
          path: state.xhttpPath,
          mode: "auto",
        },
      },
    });
    routingRules.push({ type: "field", inboundTag: ["vless-xhttp-in"], outboundTag: "direct" });
  }

  return {
    log: { loglevel: SHOW_LOG ? "warning" : "none" },
    inbounds,
    outbounds: [{ tag: "direct", protocol: "freedom" }],
    routing: { domainStrategy: "AsIs", rules: routingRules },
  };
}

function buildLinks(state, certInfo) {
  const links = [];

  if (HY2_PORT > 0) {
    const ip = getPublicIp();
    const params = new URLSearchParams({
      sni: certInfo.sni,
      insecure: "1",
      pinSHA256: certInfo.fingerprint,
      upmbps: "120",
      downmbps: "100",
    });
    links.push(`hysteria2://${encodeURIComponent(state.password)}@${ip}:${HY2_PORT}?${params.toString()}#hy2-brutal`);
  }

  if (ARGO_TOKEN) {
    const host = ARGO_DOMAIN || "example.com";
    const params = new URLSearchParams({
      encryption: "none",
      security: "tls",
      sni: host,
      type: "xhttp",
      path: state.xhttpPath,
      mode: "auto",
    });
    links.push(`vless://${state.uuid}@${host}:443?${params.toString()}#vless-xhttp-argo`);
  }

  fs.writeFileSync(LINKS_PATH, links.join("\n") + (links.length ? "\n" : ""));
  return links;
}

function spawnGoProcess(bin, args, name) {
  const child = spawn(bin, args, {
    stdio: SHOW_LOG ? "inherit" : "ignore",
    env: {
      ...process.env,
      GOMEMLIMIT: GO_MEM_LIMIT,
      GOGC: GO_GC,
    },
  });
  child.on("exit", (code, sig) => {
    if (SHOW_LOG) console.log(`[${name}] exited (code=${code}, sig=${sig})`);
  });
  return child;
}

async function main() {
  const state = loadOrCreateState();
  const certInfo = HY2_PORT > 0 ? ensureSelfSignedCert() : { fingerprint: "", sni: "bing.com" };

  await downloadBinary(XRAY_URL, XRAY_BIN);
  if (ARGO_TOKEN) {
    await downloadBinary(CF_URL, CF_BIN);
  }

  const xrayConfig = buildXrayConfig(state, certInfo);
  fs.writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(xrayConfig, null, 2));

  const links = buildLinks(state, certInfo);
  if (links.length) {
    console.log("节点链接已写入 .npm/links.txt:\n" + links.join("\n"));
  }

  const children = [];
  if (xrayConfig.inbounds.length > 0) {
    children.push(spawnGoProcess(XRAY_BIN, ["run", "-c", XRAY_CONFIG_PATH], "xray"));
  }

  if (ARGO_TOKEN) {
    children.push(
      spawnGoProcess(
        CF_BIN,
        ["tunnel", "--no-autoupdate", "run", "--token", ARGO_TOKEN],
        "cloudflared"
      )
    );
  }

  const cleanup = () => {
    for (const p of children) {
      try { p.kill("SIGTERM"); } catch {}
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
