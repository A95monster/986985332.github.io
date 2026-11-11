#!/usr/bin/env bash
# One-shot Mac install: MCP + left Activity Bar SSH panel (VSIX).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INDEX="$ROOT/src/index.js"
MCP_DIR="${HOME}/.cursor"
MCP_FILE="${MCP_DIR}/mcp.json"
DATA_DIR="${HOME}/.cursor/ssh-mcp"
VSIX="$ROOT/cursor-ssh-mcp.vsix"

echo "==> Working in $ROOT"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node 18+。请先安装: https://nodejs.org/ 或 brew install node"
  exit 1
fi
echo "Node: $(node -v)"

echo "==> npm install"
npm install

echo "==> Ensure data dir $DATA_DIR"
mkdir -p "$DATA_DIR" "$MCP_DIR"

# Merge / write mcp.json
if [[ ! -f "$MCP_FILE" ]]; then
  cat >"$MCP_FILE" <<EOF
{
  "mcpServers": {
    "cursor-ssh-mcp": {
      "command": "node",
      "args": ["${INDEX}"],
      "env": {
        "CURSOR_SSH_MCP_HOME": "\${userHome}/.cursor/ssh-mcp",
        "CURSOR_SSH_MCP_UI_PORT": "3847"
      }
    }
  }
}
EOF
  echo "Created $MCP_FILE"
else
  if grep -q 'cursor-ssh-mcp' "$MCP_FILE" 2>/dev/null; then
    echo "mcp.json 已包含 cursor-ssh-mcp，跳过写入（如路径不对请手动改 args）。"
  else
    echo "检测到已有 $MCP_FILE，请手动把下列片段合并进 mcpServers："
    cat <<EOF
    "cursor-ssh-mcp": {
      "command": "node",
      "args": ["${INDEX}"],
      "env": {
        "CURSOR_SSH_MCP_HOME": "\${userHome}/.cursor/ssh-mcp",
        "CURSOR_SSH_MCP_UI_PORT": "3847"
      }
    }
EOF
  fi
fi

echo "==> Package VSIX (left sidebar SSH button)"
npm run extension:package

echo "==> Install extension into Cursor"
INSTALLED=0
if command -v cursor >/dev/null 2>&1; then
  cursor --install-extension "$VSIX" && INSTALLED=1 || true
fi
if [[ "$INSTALLED" -eq 0 ]] && command -v code >/dev/null 2>&1; then
  # Some Mac setups alias Cursor CLI differently
  cursor --install-extension "$VSIX" 2>/dev/null && INSTALLED=1 || true
fi

if [[ "$INSTALLED" -eq 1 ]]; then
  echo "扩展已通过 CLI 安装。"
else
  echo ""
  echo "请在 Cursor 里手动安装左侧 SSH 按钮："
  echo "  1) Cmd+Shift+P"
  echo "  2) 输入：Extensions: Install from VSIX…"
  echo "  3) 选择：$VSIX"
  echo "  4) 按提示 Reload Window"
fi

echo ""
echo "完成。接下来："
echo "  1) 完全重启 Cursor（或 Developer: Reload Window）"
echo "  2) 左侧 Activity Bar 应出现 SSH 图标（点开后可拖拽调宽）"
echo "  3) 对话里可试：ssh_list_hosts / ssh_open_ui"
echo "  4) 面板 UI：http://127.0.0.1:3847/"
echo ""
echo "若没有 SSH 图标：Cmd+Shift+P → SSH: Focus Panel"
