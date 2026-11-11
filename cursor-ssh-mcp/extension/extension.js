const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

let uiProcess = null;
let output = null;
/** @type {vscode.WebviewPanel | null} */
let workbenchPanel = null;
/** @type {vscode.StatusBarItem | null} */
let statusBarItem = null;
/** 剪贴板读取限流：防止被页面脚本狂刷 */
let lastClipboardReadAt = 0;

function getOutput() {
  if (!output) {
    output = vscode.window.createOutputChannel("SSH MCP");
  }
  return output;
}

function resolvePackageRoot(context) {
  const configured = vscode.workspace
    .getConfiguration("cursorSshMcp")
    .get("packageRoot");
  if (configured && String(configured).trim()) {
    return path.resolve(String(configured).trim());
  }
  return path.resolve(context.extensionPath, "..");
}

function getUiPort() {
  return Number(
    vscode.workspace.getConfiguration("cursorSshMcp").get("uiPort") || 3847
  );
}

/**
 * auto: Windows 默认浏览器；macOS/Linux 默认 WebView（也可手动改 browser）
 * webview: 强制侧栏/工作台
 * browser: 强制系统浏览器（Win/Mac 都能避开 WebView Service Worker 报错）
 * @param {string} [mode]
 * @param {string} [platform]
 */
function resolveUseBrowserUi(mode, platform) {
  const m = String(mode || "auto").toLowerCase();
  if (m === "browser") return true;
  if (m === "webview") return false;
  return String(platform || process.platform) === "win32";
}

function getUiMode() {
  const mode = String(
    vscode.workspace.getConfiguration("cursorSshMcp").get("uiMode") || "auto"
  ).toLowerCase();
  if (mode === "webview" || mode === "browser") return mode;
  return "auto";
}

function shouldUseBrowserUi() {
  return resolveUseBrowserUi(getUiMode(), process.platform);
}

function uiUrl(port, panel) {
  if (panel === "hosts") return `http://127.0.0.1:${port}/hosts`;
  if (panel === "work") return `http://127.0.0.1:${port}/work`;
  return `http://127.0.0.1:${port}/`;
}

function resolveUiHome() {
  const override = process.env.CURSOR_SSH_MCP_HOME;
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(os.homedir(), ".cursor", "ssh-mcp");
}

function getOrCreateUiToken() {
  if (process.env.CURSOR_SSH_MCP_UI_TOKEN) {
    return String(process.env.CURSOR_SSH_MCP_UI_TOKEN).trim();
  }
  const dir = resolveUiHome();
  const file = path.join(dir, "ui-token");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (existing.length >= 24) return existing;
    }
  } catch {
    /* recreate */
  }
  const token = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* windows */
    }
  } catch (err) {
    getOutput().appendLine(
      `write ui-token failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return token;
}

function probeUi(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/health",
        timeout: 800,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureUiServer(context) {
  const port = getUiPort();
  const token = getOrCreateUiToken();
  if (await probeUi(port)) {
    return { port, alreadyRunning: true, token };
  }

  const packageRoot = resolvePackageRoot(context);
  const cli = path.join(packageRoot, "src", "ui-cli.js");
  const log = getOutput();
  log.appendLine(`Starting UI server: node ${cli} (port ${port})`);

  if (uiProcess) {
    try {
      uiProcess.kill();
    } catch {
      /* ignore */
    }
    uiProcess = null;
  }

  uiProcess = spawn(process.execPath, [cli], {
    cwd: packageRoot,
    env: {
      ...process.env,
      CURSOR_SSH_MCP_UI_PORT: String(port),
      CURSOR_SSH_MCP_UI_TOKEN: token,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  uiProcess.stdout.on("data", (buf) => log.append(String(buf)));
  uiProcess.stderr.on("data", (buf) => log.append(String(buf)));
  uiProcess.on("exit", (code) => {
    log.appendLine(`UI server exited with code ${code}`);
    if (uiProcess && uiProcess.exitCode != null) {
      uiProcess = null;
    }
  });

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await probeUi(port)) {
      return { port, alreadyRunning: false, token };
    }
  }

  throw new Error(
    `SSH UI server did not start on port ${port}. Check Output → SSH MCP. Run npm install in ${packageRoot}.`
  );
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function browserFallbackHtml(port, reason) {
  const url = `http://127.0.0.1:${port}/`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <style>
    html, body { margin:0; height:100%; background:#eef6f4; color:#16332e;
      font:13px/1.5 -apple-system, "Segoe UI", "PingFang SC", sans-serif; }
    .wrap { padding:16px; }
    h3 { margin:0 0 8px; font-size:15px; }
    p { margin:0 0 10px; opacity:.9; }
    code { background:#dceee8; padding:1px 5px; border-radius:4px; }
    button { margin:4px 8px 4px 0; padding:8px 12px; border:0; border-radius:8px;
      background:#0f766e; color:#fff; font-weight:600; cursor:pointer; }
    button.secondary { background:#334155; }
    .hint { margin-top:14px; font-size:12px; color:#475569; white-space:pre-wrap; }
  </style>
</head>
<body>
  <div class="wrap">
    <h3>SSH 面板</h3>
    <p>${escapeHtml(reason || "当前使用浏览器模式，可避开 Cursor WebView Service Worker 故障。")}</p>
    <p>本机 UI：<code>${escapeHtml(url)}</code></p>
    <button id="btn-open">在浏览器打开</button>
    <button id="btn-work" class="secondary">只开工作台</button>
    <button id="btn-hosts" class="secondary">只开主机列表</button>
    <div class="hint">若侧栏仍报 Service Worker：完全退出 Cursor 后删除
Windows: %APPDATA%\\Cursor\\Service Worker
macOS: ~/Library/Application Support/Cursor/Service Worker
也可设置 cursorSshMcp.uiMode = browser。</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById("btn-open").onclick = () => vscode.postMessage({ type: "openBrowser", panel: "all" });
    document.getElementById("btn-work").onclick = () => vscode.postMessage({ type: "openBrowser", panel: "work" });
    document.getElementById("btn-hosts").onclick = () => vscode.postMessage({ type: "openBrowser", panel: "hosts" });
  </script>
</body>
</html>`;
}

function frameHtml(src) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; frame-src ${src} http://127.0.0.1:* http://localhost:* https:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <style>
    html, body, iframe { margin:0; padding:0; width:100%; height:100%; border:0; background:#eef6f4; }
    body { overflow:hidden; }
  </style>
</head>
<body>
  <iframe src="${src}" title="SSH" allow="clipboard-read; clipboard-write"></iframe>
  <script>
    (function () {
      const vscode = acquireVsCodeApi();
      const iframe = document.querySelector("iframe");
      window.addEventListener("message", function (event) {
        const data = event.data;
        if (!data) return;
        if (data.source === "cursor-ssh-mcp-ui") {
          vscode.postMessage(data);
          return;
        }
        if (data.source === "cursor-ssh-mcp-host" && iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage(data, "*");
        }
      });
    })();
  </script>
</body>
</html>`;
}

function errorHtml(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return `<!DOCTYPE html>
<html><body style="margin:0;background:#eef6f4;color:#9a3412;font:13px 'Segoe UI',sans-serif;padding:16px;white-space:pre-wrap;">
  <strong>SSH 面板启动失败</strong>
  <p>${escapeHtml(msg)}</p>
  <p>可执行「SSH: 在浏览器打开」，或设置 <code>cursorSshMcp.uiMode</code> 为 <code>browser</code>。</p>
</body></html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {'hosts'|'work'|'all'} [panel]
 */
async function openInBrowser(context, panel = "all") {
  const info = await ensureUiServer(context);
  await vscode.env.openExternal(vscode.Uri.parse(uiUrl(info.port, panel)));
}

/**
 * @param {vscode.Webview} webview
 * @param {any} msg
 * @param {vscode.ExtensionContext} [context]
 */
async function handleUiMessage(webview, msg, context) {
  if (!msg) return;

  if (msg.type === "openBrowser" && context) {
    try {
      await openInBrowser(context, msg.panel || "all");
    } catch (err) {
      getOutput().appendLine(
        `openBrowser failed: ${err instanceof Error ? err.message : String(err)}`
      );
      vscode.window.showErrorMessage(
        `打开浏览器失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }

  if (msg.source !== "cursor-ssh-mcp-ui") return;

  if (msg.type === "clipboardRead") {
    // 必须来自用户粘贴手势；并限流，降低 XSS 静默读剪贴板风险
    const now = Date.now();
    const allowed =
      msg.userGesture === true && now - lastClipboardReadAt > 200;
    lastClipboardReadAt = now;
    let text = "";
    if (allowed) {
      try {
        text = await vscode.env.clipboard.readText();
      } catch (err) {
        getOutput().appendLine(
          `clipboard read failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    webview.postMessage({
      source: "cursor-ssh-mcp-host",
      type: "clipboardReadResult",
      requestId: msg.requestId,
      text: typeof text === "string" ? text : "",
    });
    return;
  }

  if (msg.type === "clipboardWrite") {
    try {
      await vscode.env.clipboard.writeText(String(msg.text || ""));
    } catch (err) {
      getOutput().appendLine(
        `clipboard write failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (msg.requestId) {
      webview.postMessage({
        source: "cursor-ssh-mcp-host",
        type: "clipboardWriteResult",
        requestId: msg.requestId,
        ok: true,
      });
    }
    return;
  }

  if (
    (msg.type === "openWorkbench" || msg.type === "selectHost") &&
    context
  ) {
    try {
      if (shouldUseBrowserUi()) {
        await openInBrowser(context, "work");
      } else {
        await openWorkbench(context, { preserveFocus: false });
      }
    } catch (err) {
      getOutput().appendLine(
        `openWorkbench failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

async function resolveExternalUiUrl(context, panel) {
  const info = await ensureUiServer(context);
  const target = uiUrl(info.port, panel);
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(target));
  return external.toString();
}

class SshHostsViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "media")),
      ],
    };
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      await handleUiMessage(webviewView.webview, msg, this.context);
    });
    // 不在这里自动再开工作台 WebView，避免双 WebView 抢 Service Worker
    this.refresh().catch((err) => {
      webviewView.webview.html = errorHtml(err);
    });
  }

  async refresh() {
    if (!this.view) return;
    try {
      const info = await ensureUiServer(this.context);
      if (shouldUseBrowserUi()) {
        this.view.webview.html = browserFallbackHtml(
          info.port,
          process.platform === "win32"
            ? "检测到 Windows：默认用系统浏览器打开 SSH，避开 Cursor WebView Service Worker 报错。"
            : "已启用 browser 模式：用系统浏览器打开 SSH（Win/macOS 通用）。"
        );
        return;
      }
      const src = await resolveExternalUiUrl(this.context, "hosts");
      this.view.webview.html = frameHtml(src);
    } catch (err) {
      this.view.webview.html = errorHtml(err);
    }
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ preserveFocus?: boolean, forceReload?: boolean }} [opts]
 */
async function openWorkbench(context, opts = {}) {
  if (shouldUseBrowserUi()) {
    await openInBrowser(context, "work");
    return null;
  }

  const preserveFocus = Boolean(opts.preserveFocus);
  const forceReload = Boolean(opts.forceReload);

  if (workbenchPanel) {
    workbenchPanel.reveal(vscode.ViewColumn.One, preserveFocus);
    if (!forceReload) return workbenchPanel;
    try {
      const src = await resolveExternalUiUrl(context, "work");
      workbenchPanel.webview.html = frameHtml(src);
    } catch (err) {
      workbenchPanel.webview.html = errorHtml(err);
    }
    return workbenchPanel;
  }

  workbenchPanel = vscode.window.createWebviewPanel(
    "cursorSshMcp.workbench",
    "SSH 工作台",
    { viewColumn: vscode.ViewColumn.One, preserveFocus },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, "media")),
      ],
    }
  );

  workbenchPanel.webview.onDidReceiveMessage(async (msg) => {
    if (workbenchPanel) {
      await handleUiMessage(workbenchPanel.webview, msg, context);
    }
  });
  workbenchPanel.onDidDispose(() => {
    workbenchPanel = null;
  });

  try {
    const src = await resolveExternalUiUrl(context, "work");
    workbenchPanel.webview.html = frameHtml(src);
  } catch (err) {
    workbenchPanel.webview.html = errorHtml(err);
  }
  return workbenchPanel;
}

async function refreshUiModeContext() {
  await vscode.commands.executeCommand(
    "setContext",
    "cursorSshMcp.useBrowserUi",
    shouldUseBrowserUi()
  );
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const provider = new SshHostsViewProvider(context);

  void refreshUiModeContext();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cursorSshMcp.uiMode")) {
        void refreshUiModeContext();
        void provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cursorSshMcp.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  statusBarItem.text = "$(terminal) SSH";
  statusBarItem.tooltip =
    "打开 SSH（browser 模式可避开 WebView Service Worker 问题）";
  statusBarItem.command = "cursorSshMcp.openExternal";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSshMcp.focusPanel", async () => {
      if (shouldUseBrowserUi()) {
        await openInBrowser(context, "all");
        return;
      }
      await vscode.commands.executeCommand("cursorSshMcp.panel.focus");
      await provider.refresh();
    })
  );

  const openWorkbenchCmd = async () => {
    await openWorkbench(context, { preserveFocus: false });
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSshMcp.openWorkbench", openWorkbenchCmd)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSshMcp.openEditor", openWorkbenchCmd)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSshMcp.openExternal", async () => {
      await openInBrowser(context, "all");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSshMcp.restartUi", async () => {
      if (uiProcess) {
        try {
          uiProcess.kill();
        } catch {
          /* ignore */
        }
        uiProcess = null;
      }
      await ensureUiServer(context);
      await provider.refresh();
      if (workbenchPanel && !shouldUseBrowserUi()) {
        await openWorkbench(context, { preserveFocus: true, forceReload: true });
      }
      vscode.window.showInformationMessage("SSH UI server restarted");
    })
  );

  if (shouldUseBrowserUi()) {
    const key = "cursorSshMcp.browserTipShown";
    if (!context.globalState.get(key)) {
      void context.globalState.update(key, true);
      void vscode.window.showInformationMessage(
        process.platform === "win32"
          ? "Windows 上 SSH 默认用系统浏览器打开，可避开 Cursor WebView Service Worker 报错。命令：SSH: 在浏览器打开。"
          : "SSH 当前为浏览器模式（Win/macOS 通用，可避开 WebView Service Worker 报错）。"
      );
    }
  }
}

function deactivate() {
  if (uiProcess) {
    try {
      uiProcess.kill();
    } catch {
      /* ignore */
    }
    uiProcess = null;
  }
}

module.exports = {
  activate,
  deactivate,
  // 供冒烟测试
  resolveUseBrowserUi,
  uiUrl,
};
