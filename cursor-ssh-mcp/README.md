# cursor-ssh-mcp

Termius / IDEA 风格的 **user-level** SSH 工具：保存主机、密钥/密码认证、远程 Shell、SFTP。

由两部分组成，**共用同一份用户级配置**：

| 组件 | 作用 |
|------|------|
| **MCP server** (`src/index.js`) | 给 Agent 调用的工具（`ssh_run`、`ssh_list_hosts` 等） |
| **Cursor 扩展** (`extension/`) | 左侧 Activity Bar **主机列表** + 中间编辑器 **SSH 工作台**（SFTP / 终端） |

> **重要：** Cursor 的用户级 MCP 写在本机 `~/.cursor/mcp.json`，**不会**随 Cursor 账号在多台电脑间自动同步。Skills 可选择同步到 Cloud Agents；MCP 不会。Mac / Windows 需各自安装，配置可手工同步。

官方说明：[Cursor MCP docs](https://cursor.com/docs/mcp)  
- 项目级：`.cursor/mcp.json`  
- 用户级：`~/.cursor/mcp.json`（Windows：`%USERPROFILE%\.cursor\mcp.json`）

手机 / Cloud Agents 使用**另一套** MCP 注册表，看不到本机 stdio SSH MCP，除非另行发布可网络访问的 MCP。见 [Cursor for iOS](https://cursor.com/docs/cloud-agent/mobile)。

## 面板交互（v1.3.0：侧栏主机 + 编辑器工作台）

1. 安装扩展后，左侧 Activity Bar 出现 **SSH** 图标。  
2. 点击图标 → 左侧只加载主机列表（`/?panel=hosts`），并自动打开中间编辑器 **SSH 工作台**（`/?panel=work`：SFTP + 终端）。  
3. 主机卡片与工作台通过 `BroadcastChannel` + `localStorage` 同步当前选中主机。  
4. **拖拽侧栏分隔条**即可调整宽度；再点图标或折叠主侧栏即可收起。  
5. 命令面板：`SSH: Focus Panel` / `SSH: Open Workbench` / `SSH: Open UI in Browser` / `SSH: Restart UI Server`。  
6. UI 进程监听 `127.0.0.1:3847`（可用 `CURSOR_SSH_MCP_UI_PORT` / 设置 `cursorSshMcp.uiPort` 修改）。MCP 工具 `ssh_open_ui` 也会拉起同一服务。  
7. 浏览器可打开 `/?panel=all` 或预览页 `/preview-layout.html`（hosts | work 双 iframe）。

主机与密钥材料默认存放：

```text
~/.cursor/ssh-mcp/hosts.json
~/.cursor/ssh-mcp/secrets.json   # 0600，UI 写入的密码/口令
```

可用环境变量 `CURSOR_SSH_MCP_HOME` 覆盖目录。

**不要把明文密码写进 `hosts.json`。** Agent 侧请用 `passwordEnv` / `passphraseEnv`；面板 UI 会把密码存在 `secrets.json`。

## MCP Tools

| Tool | Purpose |
|------|---------|
| `ssh_list_hosts` | 列出已保存主机 + 活动会话 |
| `ssh_upsert_host` | 新增/更新主机 |
| `ssh_remove_host` | 删除主机 |
| `ssh_test_connection` | 连通性/认证检查 |
| `ssh_run` | 远程执行命令 |
| `ssh_close_session` | 关闭 keep-alive 会话 |
| `ssh_read_file` / `ssh_write_file` | 小文件 SFTP 读写 |
| `ssh_open_ui` | 启动本地 UI（供侧栏 / 浏览器使用） |

---

## Install (Mac)

```bash
# 1) 克隆或拷贝到稳定路径
git clone <this-repo> ~/Projects/986985332.github.io
cd ~/Projects/986985332.github.io/cursor-ssh-mcp
npm install

# 2) Node 18+
node -v
```

### A. 用户级 MCP（Agent 工具，两台机器共用同一段配置模板）

创建或编辑 `~/.cursor/mcp.json`（可参考 `examples/mcp.mac.json`）：

```json
{
  "mcpServers": {
    "cursor-ssh-mcp": {
      "command": "node",
      "args": ["/Users/YOUR_NAME/Projects/986985332.github.io/cursor-ssh-mcp/src/index.js"],
      "env": {
        "CURSOR_SSH_MCP_HOME": "${userHome}/.cursor/ssh-mcp",
        "CURSOR_SSH_MCP_UI_PORT": "3847"
      }
    }
  }
}
```

重启 Cursor（或 Reload MCP）。在对话里让 Agent 调用 `ssh_list_hosts` / `ssh_open_ui`。

### B. 侧栏扩展（可拖拽 / 可折叠面板）

```bash
cd ~/Projects/986985332.github.io/cursor-ssh-mcp
npm run extension:package
# 生成 cursor-ssh-mcp.vsix
```

在 Cursor 中：

1. Command Palette → **Extensions: Install from VSIX…** → 选中 `cursor-ssh-mcp.vsix`  
2. 或开发模式：`Extensions: Install from Location…` / 打开 `extension` 文件夹后 **Developer: Reload Window**  
3. 左侧 Activity Bar 点 **SSH** 图标；拖分隔条调宽，再点图标收起  

可选设置：

- `cursorSshMcp.uiPort`（默认 3847）  
- `cursorSshMcp.packageRoot`（若扩展与包目录分离，填 `cursor-ssh-mcp` 绝对路径）

添加主机示例：

- 在侧栏点 `+`，或  
- 让 Cursor：`用 ssh_upsert_host 添加主机 id=home-nas, host=192.168.1.10, username=admin, privateKeyPath=~/.ssh/id_ed25519`  
- 或编辑 `~/.cursor/ssh-mcp/hosts.json`（模板见 `examples/hosts.example.json`）

---

## Install (Windows)

1. 安装 [Node.js 18+](https://nodejs.org/)（确保 `node` 在 PATH）。  
2. 将 `cursor-ssh-mcp` 放到例如 `C:\Users\YOUR_NAME\cursor-ssh-mcp`。  
3. 在该目录执行：

```powershell
npm install
npm run extension:package
```

4. 创建 `%USERPROFILE%\.cursor\mcp.json`（参考 `examples/mcp.windows.json`）：

```json
{
  "mcpServers": {
    "cursor-ssh-mcp": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_NAME\\cursor-ssh-mcp\\src\\index.js"],
      "env": {
        "CURSOR_SSH_MCP_HOME": "${userHome}/.cursor/ssh-mcp",
        "CURSOR_SSH_MCP_UI_PORT": "3847"
      }
    }
  }
}
```

5. Cursor → **Extensions: Install from VSIX…** → 安装生成的 `cursor-ssh-mcp.vsix`。  
6. 私钥放在例如 `C:\Users\YOUR_NAME\.ssh\id_ed25519`，在 `privateKeyPath` 中引用（JSON 字符串里可用正斜杠或转义反斜杠）。  
7. 重启 Cursor Desktop；左侧点 **SSH** 打开可拖拽侧栏；Agent 侧用 `ssh_list_hosts` 验证。

---

## 保持用户级 MCP / 主机配置同步（手工）

Cursor 账号登录 **不会** 在 Mac ↔ Windows 之间复制 `mcp.json`、扩展或本服务。

推荐流程：

1. **服务代码放在 git**（本仓库 `cursor-ssh-mcp/`），每台机器 `git pull` + `npm install`（需要时再 `npm run extension:package`）。  
2. **主机与密钥材料私密同步**（勿提交到公开仓库）：  
   - 用 iCloud / OneDrive / Syncthing（最好加密）同步 `~/.cursor/ssh-mcp/`，或  
   - 在每台机器上用侧栏 / `ssh_upsert_host` 重新添加主机。  
3. **`mcp.json` 片段保持一致**；只需按系统改 `args` 绝对路径。  
4. **私钥留在本机**（`~/.ssh` / `%USERPROFILE%\.ssh`），不要提交。  
5. 模板：`examples/mcp.mac.json`、`examples/mcp.windows.json`。

新机器检查清单：

- [ ] 安装 Node 18+  
- [ ] `git pull` + `npm install`  
- [ ] 写入用户级 `mcp.json`（正确绝对路径）  
- [ ] 安装 / 更新 SSH 扩展 VSIX  
- [ ] 同步 `hosts.json` / `secrets.json` 或重新添加主机  
- [ ] 私钥路径可用  
- [ ] 重启 Cursor → 侧栏 SSH + `ssh_list_hosts` / `ssh_test_connection`

## 仅启动 UI（调试）

```bash
cd cursor-ssh-mcp
npm run ui
# 浏览器打开 http://127.0.0.1:3847/
```

## Security notes

- 优先 SSH 密钥，少用密码。  
- Mac/Linux：`chmod 600` 私钥与 `secrets.json`。  
- 在 Cursor 中审批 MCP 工具调用（除非你显式加入允许列表）。  
- 本机 stdio MCP 只在打开 Cursor Desktop 的那台机器上可用；手机 Cloud Agents 默认不可用。

## Smoke test（无需真实 SSH）

```bash
cd cursor-ssh-mcp
npm install
npm run test:smoke
```
