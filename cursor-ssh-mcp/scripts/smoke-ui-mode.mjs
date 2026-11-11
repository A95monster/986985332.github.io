#!/usr/bin/env node
/**
 * uiMode / 浏览器兼容细测（不依赖 VS Code host）
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

let failed = 0;
function ok(name, pass, reason = "") {
  if (!pass) failed += 1;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${reason ? ` — ${reason}` : ""}`);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function httpGet(urlPath, port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: Number(port), path: urlPath, timeout: 1000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

// extension.js requires("vscode") — 用假模块注入
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      window: {
        createOutputChannel: () => ({ appendLine() {}, append() {}, show() {} }),
        createStatusBarItem: () => ({
          text: "",
          tooltip: "",
          command: "",
          show() {},
          dispose() {},
        }),
        createWebviewPanel: () => ({
          webview: { html: "", onDidReceiveMessage() {}, postMessage() {} },
          reveal() {},
          onDidDispose() {},
        }),
        registerWebviewViewProvider() {},
        showInformationMessage() {},
        showErrorMessage() {},
        onDidChangeConfiguration() {},
      },
      workspace: {
        getConfiguration: () => ({
          get: (key) => {
            if (key === "uiPort") return 3847;
            if (key === "packageRoot") return ROOT;
            if (key === "uiMode") return "auto";
            return undefined;
          },
        }),
        onDidChangeConfiguration: () => ({ dispose() {} }),
      },
      commands: {
        registerCommand: () => ({ dispose() {} }),
        executeCommand: async () => undefined,
      },
      StatusBarAlignment: { Left: 1 },
      ViewColumn: { One: 1 },
      Uri: { parse: (s) => ({ toString: () => s, fsPath: s }), file: (s) => ({ fsPath: s }) },
      env: {
        openExternal: async () => true,
        asExternalUri: async (u) => u,
        clipboard: { readText: async () => "", writeText: async () => {} },
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const ext = require(path.join(ROOT, "extension", "extension.js"));

async function main() {
  // 1) package.json 配置
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "extension", "package.json"), "utf8")
  );
  ok("version 1.3.22", pkg.version === "1.3.22", pkg.version);
  const uiMode = pkg.contributes?.configuration?.properties?.["cursorSshMcp.uiMode"];
  ok("uiMode setting exists", Boolean(uiMode));
  ok("uiMode enum", JSON.stringify(uiMode?.enum) === JSON.stringify(["auto", "webview", "browser"]));
  ok("uiMode default auto", uiMode?.default === "auto");

  // 2) 平台矩阵
  const cases = [
    ["auto", "win32", true],
    ["auto", "darwin", false],
    ["auto", "linux", false],
    ["browser", "win32", true],
    ["browser", "darwin", true],
    ["browser", "linux", true],
    ["webview", "win32", false],
    ["webview", "darwin", false],
    ["AUTO", "win32", true],
    ["", "darwin", false],
  ];
  for (const [mode, platform, expect] of cases) {
    const got = ext.resolveUseBrowserUi(mode, platform);
    ok(`resolveUseBrowserUi(${mode}, ${platform}) => ${expect}`, got === expect, `got ${got}`);
  }

  // 3) URL 规则
  ok("uiUrl hosts", ext.uiUrl(3847, "hosts") === "http://127.0.0.1:3847/hosts");
  ok("uiUrl work", ext.uiUrl(3847, "work") === "http://127.0.0.1:3847/work");
  ok("uiUrl all", ext.uiUrl(3847, "all") === "http://127.0.0.1:3847/");

  // 4) 源码关键路径仍在（粘贴桥 / 不自动双开）
  const src = fs.readFileSync(path.join(ROOT, "extension", "extension.js"), "utf8");
  ok("has clipboardRead bridge", src.includes('clipboardRead'));
  ok("has browserFallbackHtml", src.includes("browserFallbackHtml"));
  ok("no auto openWorkbench on sidebar resolve", !/resolveWebviewView[\s\S]{0,800}openWorkbench\(/.test(src));
  ok("openWorkbench respects browser mode", src.includes("if (shouldUseBrowserUi())") && src.includes("openInBrowser"));

  // 5) UI HTML 对话框挂 body（防删除卡死回归）
  const html = fs.readFileSync(path.join(ROOT, "ui", "index.html"), "utf8");
  const confirmIdx = html.indexOf('id="app-confirm"');
  const workRowIdx = html.indexOf('id="work-row"');
  const workRowEnd = html.indexOf("<!-- 全局对话框必须挂在 body");
  ok("app-confirm after work-row comment marker", confirmIdx > workRowEnd && workRowEnd > workRowIdx);

  // 6) 起 UI 服务探测（随机端口，避免与本机 3847/残留进程冲突）
  const HOME = fs.mkdtempSync("/tmp/ssh-mcp-ui-mode-");
  const PORT = String(3900 + Math.floor(Math.random() * 500));
  const childLogs = [];
  const child = spawn(process.execPath, [path.join(ROOT, "src", "ui-cli.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      CURSOR_SSH_MCP_UI_PORT: PORT,
      CURSOR_SSH_MCP_HOME: HOME,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => childLogs.push(String(b)));
  child.stderr.on("data", (b) => childLogs.push(String(b)));
  child.on("exit", (code) => childLogs.push(`exit:${code}`));
  let up = false;
  let lastErr = "";
  for (let i = 0; i < 60; i++) {
    try {
      const res = await httpGet("/api/health", PORT);
      if (res.ok) {
        up = true;
        break;
      }
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
    }
    await sleep(100);
  }
  ok(
    "UI server starts",
    up,
    up ? `port ${PORT}` : `${lastErr} | ${childLogs.join("").slice(0, 300)}`
  );

  if (up) {
    const token = fs.readFileSync(path.join(HOME, "ui-token"), "utf8").trim();
    const unauth = await httpGet("/api/hosts", PORT);
    ok("unauth /api/hosts blocked", unauth.status === 401, String(unauth.status));

    const hostsPage = await httpGet("/hosts", PORT);
    const work = await httpGet("/work", PORT);
    const all = await httpGet("/", PORT);
    ok("GET /hosts 200", hostsPage.ok, String(hostsPage.status));
    ok("GET /work 200", work.ok, String(work.status));
    ok("GET / 200", all.ok, String(all.status));
    ok("hosts page has app-confirm", hostsPage.text.includes('id="app-confirm"'));
    ok("hosts page injects token", hostsPage.text.includes("__SSH_MCP_UI_TOKEN"));
    ok("token file exists", token.length >= 24);
    ok(
      "app.js has setupPasteSupport",
      fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf8").includes("setupPasteSupport")
    );
  }

  try {
    child.kill();
  } catch {
    /* ignore */
  }
  fs.rmSync(HOME, { recursive: true, force: true });

  Module._load = originalLoad;

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nAll ui-mode checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
