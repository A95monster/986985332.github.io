# cursor-ssh-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-1.3.18-blue.svg)](./CHANGELOG.zh-CN.md)
[![Keep a Changelog](https://img.shields.io/badge/changelog-Keep%20a%20Changelog-orange.svg)](./CHANGELOG.zh-CN.md)

> **English:** [README.md](./README.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

面向 [Cursor](https://cursor.com) 的 **用户级** SSH 工作台（Termius / JetBrains 风格）：主机管理、双栏 SFTP、xterm 终端，以及供 Agent 调用的 MCP 工具。

| 组件 | 作用 |
|------|------|
| **MCP 服务**（`src/index.js`） | Agent 工具：`ssh_run`、`ssh_list_hosts` 等 |
| **Cursor 扩展**（`extension/`） | 左侧 **主机列表** + 中间 **SSH 工作台** |

两者共用本机配置目录 `~/.cursor/ssh-mcp/`。

---

## 目录

- [功能](#功能)
- [架构](#架构)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [配置](#配置)
- [使用说明](#使用说明)
- [MCP 工具](#mcp-工具)
- [脚本](#脚本)
- [目录结构](#目录结构)
- [安全](#安全)
- [参与贡献](#参与贡献)
- [更新日志](#更新日志)
- [许可证](#许可证)

---

## 功能

- **主机管理** — 增删改主机；**文件 / 终端**，或点击卡片打开默认布局（上文件、下终端）
- **连接状态** — 状态徽章可点（连接 / 断开 / 重试）；主机列表与工作台状态同步
- **双栏 SFTP** — 本地 ↔ 远端（或主机 ↔ 主机）；排序、筛选、面包屑、列宽、隐藏点文件
- **传输** — 支持**文件与文件夹**（递归）；小文件自适应约 8–12 路并发；实时进度与速度
- **同名冲突** — 弹窗：**替换** / **另存为序号** / **取消**
- **删除** — 远端递归删除，失败有明确提示
- **工作台布局** — 单面板全屏、上下互换、拖动分隔；切换文件/终端**不断开**会话
- **终端** — 主题、字体；可收起的工具栏（主题 / 历史 / Linux 字典）
- **连接体验** — 超时、认证失败、拒绝、不可达等弹窗说明
- **MCP** — 在对话中执行命令、管理主机

---

## 架构

```text
┌──────────────── Cursor Desktop ────────────────┐
│  Activity Bar          Editor                   │
│  ┌──────────┐          ┌─────────────────────┐  │
│  │ 主机列表 │  总线 +  │ SSH 工作台           │  │
│  │ webview  │ localStorage  文件 + 终端       │  │
│  └────┬─────┘          └──────────┬──────────┘  │
│       │  iframe → 127.0.0.1:3847  │             │
└───────┼───────────────────────────┼─────────────┘
        └─────────────┬─────────────┘
                      ▼
              UI 服务（Node）  ←→  SSH / SFTP（ssh2）
                      ▲
              MCP stdio（Agent 工具）
```

- 主机页与工作台为独立页面（`/hosts`、`/work`），通过 `BroadcastChannel` + `localStorage` 同步。
- 工作台已打开时再次点击**不会重载** iframe，避免掐掉终端 WebSocket。

---

## 环境要求

- **Node.js** 18+
- **Cursor Desktop**（扩展 + 用户级 MCP）
- 目标机器 SSH 可达（推荐密钥登录）

---

## 快速开始

```bash
git clone https://github.com/A95monster/986985332.github.io.git
cd 986985332.github.io/cursor-ssh-mcp
npm install
```

### 1. 用户级 MCP（给 Agent）

编辑 `~/.cursor/mcp.json`（参考 `examples/mcp.mac.json` / `examples/mcp.windows.json`）：

```json
{
  "mcpServers": {
    "cursor-ssh-mcp": {
      "command": "node",
      "args": ["/绝对路径/cursor-ssh-mcp/src/index.js"],
      "env": {
        "CURSOR_SSH_MCP_HOME": "${userHome}/.cursor/ssh-mcp",
        "CURSOR_SSH_MCP_UI_PORT": "3847"
      }
    }
  }
}
```

在 Cursor 中 Reload MCP，然后让 Agent 调用 `ssh_list_hosts` 或 `ssh_open_ui`。

### 2. Cursor 扩展（界面）

```bash
npm run extension:package
```

Cursor → **Extensions: Install from VSIX…** → 选择 `cursor-ssh-mcp.vsix` → **Developer: Reload Window**。

| 设置项 | 默认 | 说明 |
|--------|------|------|
| `cursorSshMcp.uiPort` | `3847` | 本机 UI 端口 |
| `cursorSshMcp.packageRoot` | 空 | 本包绝对路径 |

### 3. 仅启动 UI（浏览器调试）

```bash
npm run ui
# http://127.0.0.1:3847/hosts
# http://127.0.0.1:3847/work
```

---

## 配置

### 数据目录

```text
~/.cursor/ssh-mcp/hosts.json
~/.cursor/ssh-mcp/secrets.json   # 建议 0600；面板写入的密码 / 口令
```

可用 `CURSOR_SSH_MCP_HOME` 覆盖根目录。

**不要把明文密码写进 `hosts.json`。** 优先密钥，或由面板写入 `secrets.json`。

> Cursor 账号**不会**自动同步用户级 MCP / 本配置。换机器请自行拷贝模板，并私密同步 `~/.cursor/ssh-mcp/`。

### 环境变量

| 变量 | 默认 | 用途 |
|------|------|------|
| `CURSOR_SSH_MCP_HOME` | `~/.cursor/ssh-mcp` | 配置与密钥根目录 |
| `CURSOR_SSH_MCP_UI_PORT` | `3847` | UI 服务端口 |

---

## 使用说明

1. 点击 Activity Bar 的 **SSH** 图标。
2. 添加主机（密钥路径或密码）。
3. 点击**卡片**打开默认双开，或点 **文件 / 终端**。
4. 用**状态徽章**连接 / 断开 / 重试（悬停显示动作文案）。
5. SFTP：拖拽或右键「复制到对侧」；文件夹会递归；同名会询问替换 / 另存 / 取消。
6. 可全屏、上下互换、拖动分隔条；切换文件/终端模式**不会**断开 SSH。

---

## MCP 工具

| 工具 | 用途 |
|------|------|
| `ssh_list_hosts` | 列出主机与会话 |
| `ssh_upsert_host` | 新增 / 更新主机 |
| `ssh_remove_host` | 删除主机 |
| `ssh_test_connection` | 连通 / 认证检测 |
| `ssh_run` | 远程执行命令 |
| `ssh_close_session` | 关闭 keep-alive 会话 |
| `ssh_read_file` / `ssh_write_file` | 小文件读写 |
| `ssh_open_ui` | 启动本机 UI |

---

## 脚本

```bash
npm start                 # MCP 服务（stdio）
npm run ui                # UI HTTP 服务
npm run test:smoke        # 主机 API 冒烟（无需真实 SSH）
npm run test:e2e          # Playwright UI 冒烟（需浏览器）
npm run extension:package # 生成 cursor-ssh-mcp.vsix

# 安装助手
./scripts/install-mcp.sh      # macOS / Linux → ~/.cursor/mcp.json
./scripts/install-mac.sh
./scripts/install-mcp.ps1     # Windows
```

---

## 目录结构

```text
cursor-ssh-mcp/
├── src/                 # MCP + UI HTTP/WebSocket
├── ui/                  # 工作台前端
├── extension/           # Cursor 扩展源码
├── examples/            # 配置模板
├── scripts/             # 安装与测试
├── README.md            # English
├── README.zh-CN.md      # 简体中文（本文）
├── CHANGELOG.md
├── CHANGELOG.zh-CN.md
├── CONTRIBUTING.md
├── CONTRIBUTING.zh-CN.md
├── SECURITY.md
├── SECURITY.zh-CN.md
└── LICENSE
```

---

## 安全

详见 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md) / [SECURITY.md](./SECURITY.md)。

要点：

- 优先 SSH 密钥；私钥与 `secrets.json` 使用 `chmod 600`。
- 在 Cursor 中审批 MCP 工具调用。
- 本机 stdio MCP 仅在当前打开 Cursor Desktop 的电脑可用。

---

## 参与贡献

见 [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md) / [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 更新日志

[CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md) · [CHANGELOG.md](./CHANGELOG.md)  
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) · [SemVer](https://semver.org/lang/zh-CN/)。

## 许可证

[MIT](./LICENSE) © A95monster
