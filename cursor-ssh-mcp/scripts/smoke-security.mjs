#!/usr/bin/env node
/**
 * 安全回归：未授权访问应失败；持 token 可访问；路径脱敏；无测试钩子泄漏。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const HOME = fs.mkdtempSync("/tmp/ssh-mcp-sec-");
const PORT = String(4600 + Math.floor(Math.random() * 300));

let failed = 0;
let child = null;

function ok(name, pass, reason = "") {
  if (!pass) failed += 1;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${reason ? ` — ${reason}` : ""}`);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function request(pathname, { method = "GET", headers = {}, body = null, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(PORT),
        path: pathname,
        method,
        headers: {
          Host: host || `127.0.0.1:${PORT}`,
          ...(body
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
            : {}),
          ...headers,
        },
        timeout: 3000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = { raw: text };
          }
          resolve({ status: res.statusCode, data, text, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const tokenFile = path.join(HOME, "ui-token");
  child = spawn(process.execPath, [path.join(ROOT, "src", "ui-cli.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      CURSOR_SSH_MCP_UI_PORT: PORT,
      CURSOR_SSH_MCP_HOME: HOME,
      // 生产态：不开启 E2E 钩子
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const h = await request("/api/health");
      if (h.status === 200) {
        up = true;
        break;
      }
    } catch {
      /* wait */
    }
    await sleep(100);
  }
  ok("health up", up, `port ${PORT}`);
  if (!up) throw new Error("UI failed");

  const token = fs.readFileSync(tokenFile, "utf8").trim();
  ok("ui-token created", token.length >= 24);
  try {
    const mode = fs.statSync(tokenFile).mode & 0o777;
    ok("ui-token mode restrictive", mode === 0o600 || process.platform === "win32", `mode=${mode.toString(8)}`);
  } catch (e) {
    ok("ui-token mode restrictive", false, String(e));
  }

  // 未授权
  const unauthHosts = await request("/api/hosts");
  ok("GET /api/hosts without token => 401", unauthHosts.status === 401, String(unauthHosts.status));

  const unauthRun = await request("/api/test", {
    method: "POST",
    body: JSON.stringify({ id: "x" }),
  });
  ok("POST /api/test without token => 401", unauthRun.status === 401, String(unauthRun.status));

  // 坏 Host（DNS rebinding 模拟）
  const badHost = await request("/api/hosts", {
    headers: { Authorization: `Bearer ${token}` },
    host: "evil.example:80",
  });
  ok("bad Host header => 403", badHost.status === 403, String(badHost.status));

  // 错误 token
  const wrong = await request("/api/hosts", {
    headers: { Authorization: "Bearer deadbeefdeadbeefdeadbeefdeadbeef" },
  });
  ok("wrong token => 401", wrong.status === 401, String(wrong.status));

  // 授权后可用
  const authHosts = await request("/api/hosts", {
    headers: { Authorization: `Bearer ${token}` },
  });
  ok("authorized GET /api/hosts => 200", authHosts.status === 200, String(authHosts.status));

  // 创建主机（带密码）后，列表不应回传 password
  const created = await request("/api/hosts", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      id: "sec-host",
      name: "sec",
      host: "127.0.0.1",
      port: 22,
      username: "u",
      privateKeyPath: path.join(HOME, "fake-key"),
      password: "super-secret-password",
    }),
  });
  ok("create host => 200", created.status === 200, String(created.status));
  const listed = await request("/api/hosts", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const raw = JSON.stringify(listed.data || {});
  ok("response has no raw password", !raw.includes("super-secret-password"));
  ok("secrets file exists", fs.existsSync(path.join(HOME, "secrets.json")));
  const secrets = fs.readFileSync(path.join(HOME, "secrets.json"), "utf8");
  ok("secrets contain password at rest", secrets.includes("super-secret-password"));

  // MCP 脱敏：maskPath
  const { maskPath } = await import(path.join(ROOT, "src", "hosts.js"));
  const home = require("os").homedir();
  const masked = maskPath(path.join(home, ".ssh", "id_ed25519"));
  ok("maskPath hides middle", masked.includes("…") || masked.startsWith("~"), masked);
  ok("maskPath keeps basename", masked.endsWith("id_ed25519"), masked);

  // HTML 注入 token，但生产无 E2E 钩子
  const page = await request("/hosts", {
    headers: { Authorization: `Bearer ${token}` },
  });
  ok("HTML injects token", page.text.includes("__SSH_MCP_UI_TOKEN"));
  ok("HTML has no E2E flag by default", !page.text.includes("__SSH_MCP_E2E=true"));
  ok("HTML sets auth cookie", String(page.headers["set-cookie"] || "").includes("cursor_ssh_mcp_token"));

  // app.js 生产钩子受 E2E 保护
  const appJs = fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf8");
  ok("test hook gated by __SSH_MCP_E2E", appJs.includes("window.__SSH_MCP_E2E === true"));
  ok("escapeHtml escapes quotes", appJs.includes('&quot;') && appJs.includes("&#39;"));
  ok("api sends Authorization", appJs.includes("Authorization"));
  ok("paste gate exists", appJs.includes("pasteGateOpen") && appJs.includes("armPasteGate"));

  // 未授权 WS 握手拒绝（用 raw upgrade 太重，改测 extract）
  const authMod = await import(path.join(ROOT, "src", "ui-auth.js"));
  ok(
    "isAuthorized false without header",
    !authMod.isAuthorized({ headers: {}, url: "/ws/shell?id=x" }, token)
  );
  ok(
    "isAuthorized true with bearer",
    authMod.isAuthorized(
      { headers: { authorization: `Bearer ${token}` }, url: "/x" },
      token
    )
  );
  ok(
    "isAuthorized true with query token",
    authMod.isAuthorized({ headers: {}, url: `/ws/shell?id=a&token=${token}` }, token)
  );
  ok("evil host rejected", !authMod.isAllowedHostHeader("attacker.com"));
  ok("localhost host allowed", authMod.isAllowedHostHeader("127.0.0.1:3847"));

  try {
    child.kill();
  } catch {
    /* ignore */
  }
  fs.rmSync(HOME, { recursive: true, force: true });

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nAll security checks passed");
}

main().catch((err) => {
  console.error(err);
  try {
    child?.kill();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
