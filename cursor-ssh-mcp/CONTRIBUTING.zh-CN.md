# 贡献指南

感谢你改进 **cursor-ssh-mcp**。

English: [CONTRIBUTING.md](./CONTRIBUTING.md)

## 行为准则

Issue / PR 中请保持尊重；拒绝人身攻击与骚扰。

## 本地开发

```bash
git clone https://github.com/A95monster/986985332.github.io.git
cd 986985332.github.io/cursor-ssh-mcp
npm install
npm run ui          # http://127.0.0.1:3847/work
npm run test:smoke
```

可选 UI e2e（需 Playwright 浏览器）：

```bash
npm run test:e2e
```

打包 Cursor 扩展：

```bash
npm run extension:package
# → cursor-ssh-mcp.vsix
```

## 目录说明

| 路径 | 作用 |
|------|------|
| `src/` | MCP 服务 + 本机 UI HTTP/WebSocket |
| `ui/` | 工作台前端（主机 / SFTP / 终端 / 工具栏） |
| `extension/` | Cursor Activity Bar + 编辑器 webview |
| `examples/` | `mcp.json` / 主机模板 |
| `scripts/` | 安装脚本与冒烟 / e2e |

## 约定

1. **Node ≥ 18**，核心保持 ESM、尽量免构建。
2. 不要提交密钥、`secrets.json`、真实密码。
3. 工作台文案用**中文**，代码标识符保持英文。
4. UI 改动请同时在浏览器（`/hosts`、`/work`）与 Cursor 侧栏/工作台验证。
5. 同步更新 **CHANGELOG.md** 与 **CHANGELOG.zh-CN.md**，并一起 bump `package.json` 与 `extension/package.json`。
6. 提交与 PR 尽量小而聚焦。

## Pull Request 检查清单

- [ ] 你改过的路径已冒烟 / 手工验证
- [ ] 用户可见变更已写中英文 Changelog
- [ ] 可发布变更已 bump 版本号
- [ ] UI 变更附截图或简短说明
- [ ] diff 中无凭据

**目标分支：** `cursor/ssh-mcp-user-level-b084`（或当前开发分支）。

## 发布说明风格

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)：`新增` / `变更` / `修复` / `移除` / `安全`。

## 安全

见 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md)。勿在 Issue / PR 中粘贴私钥。
