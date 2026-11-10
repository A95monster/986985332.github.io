# Merge cursor-ssh-mcp into %USERPROFILE%\.cursor\mcp.json (Windows).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Index = Join-Path $Root "src\index.js"
$McpDir = Join-Path $env:USERPROFILE ".cursor"
$McpFile = Join-Path $McpDir "mcp.json"
$DataDir = Join-Path $McpDir "ssh-mcp"

New-Item -ItemType Directory -Force -Path $McpDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$IndexJson = $Index -replace '\\', '\\'

if (-not (Test-Path $McpFile)) {
  @"
{
  "mcpServers": {
    "cursor-ssh-mcp": {
      "command": "node",
      "args": ["$IndexJson"],
      "env": {
        "CURSOR_SSH_MCP_HOME": "`${userHome}/.cursor/ssh-mcp",
        "CURSOR_SSH_MCP_UI_PORT": "3847"
      }
    }
  }
}
"@ | Set-Content -Path $McpFile -Encoding UTF8
  Write-Host "Created $McpFile"
} else {
  Write-Host "Existing $McpFile — merge manually using:"
  Write-Host "  command: node"
  Write-Host "  args: [`"$Index`"]"
}

Write-Host "Next: npm install; npm run extension:package; Install from VSIX in Cursor."
