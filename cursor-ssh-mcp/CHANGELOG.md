# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

中文版：[CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)

## [1.3.19] - 2026-11-11

### Fixed
- Paste works in all inputs (Ctrl/Cmd+V) via extension-host clipboard bridge; compatible with Windows/macOS Cursor iframes.
- Delete host no longer relies on `window.confirm` (often broken in iframes); uses in-app confirm dialog.
- Host form placeholders clarified: gray text is example-only; empty private key path means password auth (no default key file).

## [1.3.18] - 2026-11-11

### Added
- Same-name conflict dialog on transfer: **替换** / **另存为序号**（`a2.txt` / `folder2`） / **取消**.

### Fixed
- Remote delete now auto-detects file vs directory and recursively removes folders (uploaded files/folders can be deleted reliably).

## [1.3.17] - 2026-11-11

### Added
- Recursive folder copy to the opposite pane (upload / download / host-to-host relay).
- Adaptive multi-file concurrency (up to 8–12 parallel files) plus per-file chunk parallelism.

### Changed
- Context menu **复制到对侧目录** and drag-drop now accept folders, not only files.

## [1.3.16] - 2026-11-11

### Changed
- Removed the separate **断开连接** link; status pill is now the control (hover shows 连接/断开/重试/取消).

### Fixed
- Switching **文件 / 终端** reuses the live session (workbench no longer reloads the iframe; terminal WebSocket stays up).
- Hiding a pane does not disconnect; only the status control disconnects.

## [1.3.15] - 2026-11-11

### Added
- Connection failure dialog for terminal/SFTP (timeout, auth, refused, unreachable), with clearer Chinese reasons.

### Fixed
- Clicking **终端 / 文件** (or the host card) auto-updates host list status on success/failure without needing Refresh.
- Opening the default split now always starts the terminal session.

## [1.3.14] - 2026-11-11

### Fixed
- Host list status stays in sync with the workbench terminal (connected / idle / error) across the two webviews.

## [1.3.13] - 2026-11-11

### Changed
- Host card actions are one row: **文件 / 终端 / 编辑 / 删除** (removed **默认**).
- Clicking the host card opens the default split: files on top, terminal below.

### Added
- Per-panel **全屏 / 还原** next to Close.
- **上下互换** on the split handle; drag still resizes terminal height.

## [1.3.12] - 2026-11-11

### Fixed
- After closing the SSH workbench tab, host actions **文件 / 终端 / 默认** reopen the workbench instead of doing nothing.

## [1.3.11] - 2026-11-11

### Added
- Util rail (Theme / History / Dictionary) follows the active terminal theme colors.

### Fixed
- Hide panel close buttons when only SFTP or only Terminal is visible.

## [1.3.10] - 2026-11-11

### Changed
- Single-panel layout no longer shows a non-functional Close button.

## [1.3.9] - 2026-11-11

### Added
- Collapsible util rail to give more space to the terminal.
- Terminal toolbar toggle for util rail.

### Fixed
- Context menu actions use in-app dialogs (works inside Cursor webview/iframe).
- File list auto-refreshes after rename / delete / mkdir / chmod.

## [1.3.8] - 2026-11-11

### Fixed
- Right-click file operations blocked by `prompt()` / `confirm()` in Cursor iframe.

## [1.3.7] - 2026-11-11

### Added
- Multi-file / large-file transfers via `fastPut` / `fastGet`.
- Concurrent uploads, retries, SSH keepalive.
- NDJSON progress stream with speed display.

## [1.3.6] - 2026-11-11

### Changed
- Permissions (`drwxr-xr-x`) shown under the filename.
- Resizable SFTP table columns with vertical separators.

## [1.3.5] - 2026-11-11

### Added
- Chinese SFTP table (name / mtime / size / type).
- Sort, filter, breadcrumb, hide-dotfiles toggle.
- Context menu: copy / rename / delete / mkdir / chmod.

## [1.3.0] - 2026-11-11

### Added
- Split UI: hosts in Activity Bar, workbench in editor center.
- Dual-pane SFTP, themes, command history, Linux dictionary.

## [1.2.0] - 2026-11-10

### Added
- Host CRUD in UI, secrets stored locally.

## [1.0.0] - 2026-11-09

### Added
- Initial user-level MCP + Cursor extension for SSH hosts, shell, and SFTP.
