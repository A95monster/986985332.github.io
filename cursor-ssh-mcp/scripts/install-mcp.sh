#!/usr/bin/env bash
# Merge cursor-ssh-mcp into ~/.cursor/mcp.json (Mac/Linux).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INDEX="$ROOT/src/index.js"
MCP_DIR="${HOME}/.cursor"
MCP_FILE="${MCP_DIR}/mcp.json"

mkdir -p "$MCP_DIR"
mkdir -p "${HOME}/.cursor/ssh-mcp"

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
  echo "Existing $MCP_FILE — merge manually using:"
  echo "  command: node"
  echo "  args: [\"$INDEX\"]"
fi

echo "Next: npm install && npm run extension:package, then Install from VSIX in Cursor."
