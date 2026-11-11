# Contributing

Thanks for helping improve **cursor-ssh-mcp**.

中文版：[CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)

## Code of conduct

Be respectful in issues and PRs. Harassment or personal attacks are not acceptable.

## Development setup

```bash
git clone https://github.com/A95monster/986985332.github.io.git
cd 986985332.github.io/cursor-ssh-mcp
npm install
npm run ui          # http://127.0.0.1:3847/work
npm run test:smoke
```

Optional UI e2e (Playwright browsers required):

```bash
npm run test:e2e
```

Package the Cursor extension:

```bash
npm run extension:package
# → cursor-ssh-mcp.vsix
```

## Project layout

| Path | Role |
|------|------|
| `src/` | MCP server + local UI HTTP/WebSocket server |
| `ui/` | Workbench front-end (hosts / SFTP / terminal / util rail) |
| `extension/` | Cursor Activity Bar + editor webview host |
| `examples/` | Sample `mcp.json` / hosts templates |
| `scripts/` | Install helpers + smoke / e2e |

## Guidelines

1. **Node ≥ 18**, plain ESM for core (no required build step).
2. Never commit secrets, private keys, `secrets.json`, or real passwords.
3. Workbench **UI copy in Chinese**; code identifiers in English.
4. Verify UI in both the browser (`/hosts`, `/work`) and Cursor side bar / workbench.
5. Update **both** `CHANGELOG.md` and `CHANGELOG.zh-CN.md`, and bump `package.json` + `extension/package.json` together.
6. Prefer small, focused commits and PRs.

## Pull request checklist

- [ ] Smoke / manual path you changed still works
- [ ] Changelog entries (EN + ZH) for user-visible changes
- [ ] Version bump when shipping a releaseable change
- [ ] Screenshots or short notes for UI changes
- [ ] No credentials in the diff

**Target branch:** `cursor/ssh-mcp-user-level-b084` (or the current development branch).

## Release notes style

Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections: `Added` / `Changed` / `Fixed` / `Removed` / `Security`.

## Security

See [SECURITY.md](./SECURITY.md). Never paste private keys into issues or PRs.
