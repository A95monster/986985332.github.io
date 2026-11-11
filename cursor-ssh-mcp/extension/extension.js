const vscode = require("vscode");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

let uiProcess = null;
let output = null;
/** @type {vscode.WebviewPanel | null} */
let workbenchPanel = null;

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
  // extension/ lives inside cursor-ssh-mcp/
  return path.resolve(context.extensionPath, "..");
}

function getUiPort() {
  return Number(
    vscode.workspace.getConfiguration("cursorSshMcp").get("uiPort") || 3847
  );
}

function uiUrl(port, panel) {
  // 用路径而不是 query，避免 asExternalUri 丢掉 panel 参数导致左右重复
  if (panel === "hosts") return `http://127.0.0.1:${port}/hosts`;
  if (panel === "work") return `http://127.0.0.1:${port}/work`;
  return `http://127.0.0.1:${port}/`;
}

function probeUi(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/hosts",
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
  if (await probeUi(port)) {
    return { port, alreadyRunning: true };
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
      return { port, alreadyRunning: false };
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

function loadingHtml(message) {
  return `<!DOCTYPE html>
<html><body style="margin:0;background:#eef6f4;color:#16332e;font:13px 'PingFang SC',sans-serif;padding:16px;">
  ${escapeHtml(message)}
</body></html>`;
}

function errorHtml(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return `<!DOCTYPE html>
<html><body style="margin:0;background:#eef6f4;color:#9a3412;font:13px 'PingFang SC',sans-serif;padding:16px;white-space:pre-wrap;">
  <strong>SSH 面板启动失败</strong>
  <p>${escapeHtml(msg)}</p>
  <p>请在 cursor-ssh-mcp 目录执行 <code>npm install</code>，然后运行命令「SSH: Restart UI Server」。</p>
</body></html>`;
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
      window.addEventListener("message", function (event) {
        const data = event.data;
        if (!data || data.source !== "cursor-ssh-mcp-ui") return;
        vscode.postMessage(data);
      });
    })();
  </script>
</body>
</html>`;
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
    webviewView.webview.html = loadingHtml("正在加载主机列表…");
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || msg.source !== "cursor-ssh-mcp-ui") return;
      // 主机侧栏点「文件 / 终端 / 默认」时，若工作台已关闭则重新打开
      if (msg.type === "openWorkbench" || msg.type === "selectHost") {
        try {
          await openWorkbench(this.context, { preserveFocus: false });
        } catch (err) {
          getOutput().appendLine(
            `openWorkbench failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    });
    this.refresh()
      .then(() => openWorkbench(this.context, { preserveFocus: true }))
      .catch((err) => {
        webviewView.webview.html = errorHtml(err);
      });
  }

  async refresh() {
    if (!this.view) return;
    try {
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
  const preserveFocus = Boolean(opts.preserveFocus);
  const forceReload = Boolean(opts.forceReload);

  // 已打开时只前置，不重载 iframe——否则终端 WebSocket / 会话会被打断
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

  workbenchPanel.webview.html = loadingHtml("正在打开 SSH 工作台…");
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

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const provider = new SshHostsViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cursorSshMcp.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSshMcp.focusPanel", async () => {
      await vscode.commands.executeCommand("cursorSshMcp.panel.focus");
      await provider.refresh();
      await openWorkbench(context, { preserveFocus: false });
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
      const info = await ensureUiServer(context);
      await vscode.env.openExternal(
        vscode.Uri.parse(uiUrl(info.port, "all"))
      );
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
      await provider.refresh();
      if (workbenchPanel) {
        await openWorkbench(context, { preserveFocus: true, forceReload: true });
      }
      vscode.window.showInformationMessage("SSH UI server restarted");
    })
  );
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

module.exports = { activate, deactivate };
