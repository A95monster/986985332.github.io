# Security Policy

中文版：[SECURITY.zh-CN.md](./SECURITY.zh-CN.md)

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.3.x   | ✅ |
| < 1.3   | ❌ Best-effort only |

## Reporting a vulnerability

Please **do not** open a public issue for credential leaks, auth bypasses, or remote code execution risks.

Prefer:

1. Email / private contact via the GitHub profile of [@A95monster](https://github.com/A95monster), or
2. A **private** security advisory on the repository if available.

Include:

- Affected version / commit
- Reproduction steps (without real private keys or passwords)
- Impact assessment

We will acknowledge reports as soon as practical and coordinate a fix + disclosure window when needed.

## Hardening checklist (operators)

- Prefer **SSH public-key** auth; avoid long-lived passwords in the UI when possible.
- Keep `~/.cursor/ssh-mcp/secrets.json` and private keys at `0600` (Unix).
- Do not commit `hosts.json` with secrets, private keys, or production IPs into public forks.
- Review MCP tool allowlists in Cursor; `ssh_run` can execute arbitrary remote commands you approve.
- Bind the UI to localhost only (default `127.0.0.1`); do not expose port `3847` to untrusted networks.
- Treat this as a **local desktop** tool: the MCP process runs with your user privileges.

## Out of scope

- Compromised Cursor / OS accounts on the same machine
- Misconfigured remote SSH servers / weak remote passwords
- Third-party themes or scripts pasted into the terminal
