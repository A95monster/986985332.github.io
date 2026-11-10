const vscode = require("vscode");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

let uiProcess = null;
let output = null;

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

function uiUrl(port) {
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
    return { port, url: uiUrl(port), alreadyRunning: true };
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
      return { port, url: uiUrl(port), alreadyRunning: false };
    }
  }

  throw new Error(
    `SSH UI server did not start on port ${port}. Check Output → SSH MCP. Run npm install in ${packageRoot}.`
  );
}

class SshPanelProvider {
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
    webviewView.webview.html = this.loadingHtml("Starting SSH panel…");
    this.refresh().catch((err) => {
      webviewView.webview.html = this.errorHtml(err);
    });
  }

  async refresh() {
    if (!this.view) return;
    try {
      const info = await ensureUiServer(this.context);
      const external = await vscode.env.asExternalUri(
        vscode.Uri.parse(info.url)
      );
      this.view.webview.html = this.frameHtml(external.toString());
    } catch (err) {
      this.view.webview.html = this.errorHtml(err);
    }
  }

  loadingHtml(message) {
    return `<!DOCTYPE html>
<html><body style="margin:0;background:#1e1e1e;color:#ccc;font:13px sans-serif;padding:16px;">
  ${escapeHtml(message)}
</body></html>`;
  }

  errorHtml(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `<!DOCTYPE html>
<html><body style="margin:0;background:#1e1e1e;color:#f0c0c0;font:13px sans-serif;padding:16px;white-space:pre-wrap;">
  <strong>SSH panel failed to start</strong>
  <p>${escapeHtml(msg)}</p>
  <p>Install deps: <code>npm install</code> in cursor-ssh-mcp, then run command “SSH: Restart UI Server”.</p>
</body></html>`;
  }

  frameHtml(src) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; frame-src ${src} http://127.0.0.1:* http://localhost:* https:; style-src 'unsafe-inline';" />
  <style>
    html, body, iframe { margin:0; padding:0; width:100%; height:100%; border:0; background:#2b2b2b; }
    body { overflow:hidden; }
  </style>
</head>
<body>
  <iframe src="${src}" title="SSH" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const provider = new SshPanelProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cursorSshMcp.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSshMcp.focusPanel", async () => {
      await vscode.commands.executeCommand("cursorSshMcp.panel.focus");
      await provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSshMcp.openExternal", async () => {
      const info = await ensureUiServer(context);
      await vscode.env.openExternal(vscode.Uri.parse(info.url));
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
