# cursor-ssh-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-1.3.18-blue.svg)](./CHANGELOG.md)
[![Keep a Changelog](https://img.shields.io/badge/changelog-Keep%20a%20Changelog-orange.svg)](./CHANGELOG.md)

> **中文文档：** [README.zh-CN.md](./README.zh-CN.md) · [贡献指南](./CONTRIBUTING.zh-CN.md) · [安全说明](./SECURITY.zh-CN.md)

A **user-level** SSH workbench for [Cursor](https://cursor.com) — Termius / JetBrains-style hosts, dual-pane SFTP, xterm shell, and MCP tools for the Agent.

| Piece | What it does |
|-------|----------------|
| **MCP server** (`src/index.js`) | Agent tools: `ssh_run`, `ssh_list_hosts`, … |
| **Cursor extension** (`extension/`) | Activity Bar **Hosts** + editor **SSH Workbench** |

Both share the same on-disk config under `~/.cursor/ssh-mcp/`.

---

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Usage](#usage)
- [MCP tools](#mcp-tools)
- [Scripts](#scripts)
- [Project layout](#project-layout)
- [Security](#security)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

---

## Features

- **Host manager** — add / edit / delete hosts; open **Files**, **Terminal**, or click the card for the default split (files on top, terminal below)
- **Session status** — interactive status pill (connect / disconnect / retry); host list stays in sync with the workbench
- **Dual-pane SFTP** — local ↔ remote or host ↔ host; sort, filter, breadcrumbs, column resize, hidden files toggle
- **Transfers** — files **and folders** (recursive); adaptive concurrency (≈8–12 small files); live progress & speed
- **Name conflicts** — dialog: **Replace** / **Save as `name2`** / **Cancel**
- **Delete** — remote recursive delete with clear errors
- **Workbench layout** — per-pane fullscreen; swap files/terminal; drag to resize; sessions survive pane hide / mode switch
- **Terminal** — themes, fonts, collapsible util rail (theme / history / Linux dictionary)
- **Connection UX** — failure dialogs for timeout, auth, refused, unreachable
- **MCP** — run commands and manage hosts from Cursor chat

---

## Architecture

```text
┌──────────────── Cursor Desktop ────────────────┐
│  Activity Bar          Editor                   │
│  ┌──────────┐          ┌─────────────────────┐  │
│  │ Hosts    │  bus +   │ SSH Workbench       │  │
│  │ webview  │ localStorage  SFTP + Terminal  │  │
│  └────┬─────┘          └──────────┬──────────┘  │
│       │  iframe → 127.0.0.1:3847  │             │
└───────┼───────────────────────────┼─────────────┘
        └─────────────┬─────────────┘
                      ▼
              UI server (Node)  ←→  SSH / SFTP (ssh2)
                      ▲
              MCP stdio (Agent tools)
```

- Hosts and Workbench are **separate pages** (`/hosts`, `/work`) synced via `BroadcastChannel` + `localStorage`.
- Opening the workbench again **does not reload** an existing tab (keeps the terminal WebSocket alive).

---

## Requirements

- **Node.js** 18+
- **Cursor Desktop** (extension + user-level MCP)
- SSH reachability to your servers (keys recommended)

---

## Quick start

```bash
git clone https://github.com/A95monster/986985332.github.io.git
cd 986985332.github.io/cursor-ssh-mcp
npm install
```

### 1. User-level MCP (Agent)

Edit `~/.cursor/mcp.json` (see `examples/mcp.mac.json` / `examples/mcp.windows.json`):

```json
{
  "mcpServers": {
    "cursor-ssh-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/cursor-ssh-mcp/src/index.js"],
      "env": {
        "CURSOR_SSH_MCP_HOME": "${userHome}/.cursor/ssh-mcp",
        "CURSOR_SSH_MCP_UI_PORT": "3847"
      }
    }
  }
}
```

Reload MCP in Cursor, then ask the Agent to call `ssh_list_hosts` or `ssh_open_ui`.

### 2. Cursor extension (UI)

```bash
npm run extension:package
```

Cursor → **Extensions: Install from VSIX…** → `cursor-ssh-mcp.vsix` → **Developer: Reload Window**.

| Setting | Default | Meaning |
|---------|---------|---------|
| `cursorSshMcp.uiPort` | `3847` | Local UI HTTP port |
| `cursorSshMcp.packageRoot` | _(empty)_ | Absolute path to this package |

### 3. UI only (browser debug)

```bash
npm run ui
# http://127.0.0.1:3847/hosts
# http://127.0.0.1:3847/work
```

---

## Configuration

### Data directory

```text
~/.cursor/ssh-mcp/hosts.json
~/.cursor/ssh-mcp/secrets.json   # mode 0600; passwords / passphrases from the UI
```

Override root with `CURSOR_SSH_MCP_HOME`.

**Do not put plaintext passwords in `hosts.json`.** Prefer SSH keys, or let the UI store secrets in `secrets.json`.

> Cursor does **not** sync user-level MCP config across machines. Copy templates and sync `~/.cursor/ssh-mcp/` privately if needed.

### Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `CURSOR_SSH_MCP_HOME` | `~/.cursor/ssh-mcp` | Config + secrets root |
| `CURSOR_SSH_MCP_UI_PORT` | `3847` | UI server port |

---

## Usage

1. Open the **SSH** icon in the Activity Bar.
2. Add a host (key path or password).
3. Click the **card** → default split (files + terminal), or use **文件 / 终端**.
4. Use the **status pill** to connect / disconnect / retry (hover shows the action).
5. In SFTP: drag or right-click **复制到对侧**; folders are recursive; conflicts ask Replace / Save-as / Cancel.
6. Fullscreen a pane, swap stack order, or drag the splitter — switching modes does **not** drop the SSH session.

---

## MCP tools

| Tool | Purpose |
|------|---------|
| `ssh_list_hosts` | List saved hosts + sessions |
| `ssh_upsert_host` | Create / update a host |
| `ssh_remove_host` | Remove a host |
| `ssh_test_connection` | Connectivity / auth check |
| `ssh_run` | Run a remote command |
| `ssh_close_session` | Close a keep-alive session |
| `ssh_read_file` / `ssh_write_file` | Small-file SFTP I/O |
| `ssh_open_ui` | Start the local UI server |

---

## Scripts

```bash
npm start                 # MCP server (stdio)
npm run ui                # UI HTTP server
npm run test:smoke        # Hosts API smoke (no SSH required)
npm run test:e2e          # Playwright UI smoke (optional browsers)
npm run extension:package # Build cursor-ssh-mcp.vsix

# Install helpers
./scripts/install-mcp.sh      # macOS / Linux → ~/.cursor/mcp.json
./scripts/install-mac.sh
./scripts/install-mcp.ps1     # Windows
```

---

## Project layout

```text
cursor-ssh-mcp/
├── src/                 # MCP + UI HTTP/WebSocket server
├── ui/                  # Workbench front-end
├── extension/           # Cursor VSIX source
├── examples/            # mcp.json / hosts samples
├── scripts/             # install + smoke / e2e
├── README.md            # English (this file)
├── README.zh-CN.md      # 简体中文
├── CHANGELOG.md
├── CHANGELOG.zh-CN.md
├── CONTRIBUTING.md
├── CONTRIBUTING.zh-CN.md
├── SECURITY.md
├── SECURITY.zh-CN.md
└── LICENSE
```

---

## Security

See [SECURITY.md](./SECURITY.md) / [SECURITY.zh-CN.md](./SECURITY.zh-CN.md).

Highlights:

- Prefer SSH keys; protect keys and `secrets.json` (`chmod 600`).
- Approve MCP tool calls in Cursor unless you explicitly allowlist them.
- This stdio MCP only runs on the machine where Cursor Desktop is open.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) / [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md).

## Changelog

[CHANGELOG.md](./CHANGELOG.md) · [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)  
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [SemVer](https://semver.org/).

## License

[MIT](./LICENSE) © A95monster
