#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  dataDir,
  getHost,
  hostsPath,
  listHostsPublic,
  removeHost,
  upsertHost,
} from "./hosts.js";
import {
  closeSession,
  listSessions,
  runCommand,
  sftpRead,
  sftpWrite,
  withConnection,
} from "./ssh.js";
import { getUiUrl, startUiServer } from "./ui-server.js";

function text(data) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function toolError(err) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: err instanceof Error ? err.message : String(err),
      },
    ],
  };
}

const server = new McpServer({
  name: "cursor-ssh-mcp",
  version: "1.0.0",
});

server.tool(
  "ssh_list_hosts",
  "List saved SSH hosts (Termius-like host inventory).",
  {},
  async () => {
    try {
      return text({
        dataDir: dataDir(),
        hostsFile: hostsPath(),
        hosts: listHostsPublic(),
        activeSessions: listSessions(),
      });
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "ssh_upsert_host",
  "Create or update a saved SSH host. Prefer privateKeyPath; for passwords use passwordEnv (env var name), never store raw passwords.",
  {
    id: z.string().describe("Stable host id, e.g. prod-api"),
    name: z.string().optional().describe("Display name"),
    host: z.string().describe("Hostname or IP"),
    port: z.number().int().positive().optional().describe("SSH port, default 22"),
    username: z.string().describe("SSH username"),
    privateKeyPath: z
      .string()
      .optional()
      .describe("Path to private key, supports ~/"),
    passphraseEnv: z
      .string()
      .optional()
      .describe("Env var name for key passphrase"),
    passwordEnv: z
      .string()
      .optional()
      .describe("Env var name for password auth"),
    defaultCwd: z.string().optional().describe("Default remote working directory"),
    tags: z.array(z.string()).optional(),
  },
  async (args) => {
    try {
      return text({ host: upsertHost(args) });
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "ssh_remove_host",
  "Remove a saved SSH host by id.",
  {
    id: z.string(),
  },
  async ({ id }) => {
    try {
      closeSession(id);
      return text(removeHost(id));
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "ssh_test_connection",
  "Open an SSH session and run a trivial command to verify auth and connectivity.",
  {
    id: z.string().describe("Saved host id"),
    keepAlive: z
      .boolean()
      .optional()
      .describe("Keep the SSH session open for later commands"),
  },
  async ({ id, keepAlive }) => {
    try {
      const host = getHost(id);
      const result = await withConnection(host, Boolean(keepAlive), (conn) =>
        runCommand(conn, "echo ok && uname -a && whoami", { timeoutMs: 20000 })
      );
      return text({
        host: host.id,
        ok: result.exitCode === 0,
        ...result,
        activeSessions: listSessions(),
      });
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "ssh_run",
  "Execute a remote shell command on a saved host. Returns stdout, stderr, and exitCode.",
  {
    id: z.string().describe("Saved host id"),
    command: z.string().describe("Shell command to run"),
    cwd: z.string().optional().describe("Remote working directory override"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in ms, default 60000"),
    keepAlive: z
      .boolean()
      .optional()
      .describe("Reuse/keep SSH session after the command"),
  },
  async ({ id, command, cwd, timeoutMs, keepAlive }) => {
    try {
      const host = getHost(id);
      const result = await withConnection(host, Boolean(keepAlive), (conn) =>
        runCommand(conn, command, {
          cwd: cwd || host.defaultCwd || undefined,
          timeoutMs: timeoutMs || 60000,
        })
      );
      return text({
        host: host.id,
        command,
        cwd: cwd || host.defaultCwd || null,
        ...result,
      });
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "ssh_close_session",
  "Close a kept-alive SSH session for a host id.",
  {
    id: z.string(),
  },
  async ({ id }) => text(closeSession(id))
);

server.tool(
  "ssh_read_file",
  "SFTP read a small remote text file (default max 256 KiB).",
  {
    id: z.string(),
    path: z.string().describe("Absolute remote file path"),
    maxBytes: z.number().int().positive().optional(),
    keepAlive: z.boolean().optional(),
  },
  async ({ id, path, maxBytes, keepAlive }) => {
    try {
      const host = getHost(id);
      const result = await withConnection(host, Boolean(keepAlive), (conn) =>
        sftpRead(conn, path, maxBytes || 256 * 1024)
      );
      return text({ host: host.id, ...result });
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "ssh_write_file",
  "SFTP write a small remote text file.",
  {
    id: z.string(),
    path: z.string().describe("Absolute remote file path"),
    content: z.string().describe("UTF-8 file contents"),
    createDirs: z
      .boolean()
      .optional()
      .describe("Create parent directories if missing"),
    keepAlive: z.boolean().optional(),
  },
  async ({ id, path, content, createDirs, keepAlive }) => {
    try {
      const host = getHost(id);
      const result = await withConnection(host, Boolean(keepAlive), (conn) =>
        sftpWrite(conn, path, content, { createDirs: Boolean(createDirs) })
      );
      return text({ host: host.id, ...result });
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "ssh_open_ui",
  "Start the local SSH side-panel UI server (hosts / SFTP / terminal). Open the Cursor SSH Activity Bar icon to show the resizable panel; the same UI is also available at the returned localhost URL.",
  {
    port: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("UI port, default 3847 (CURSOR_SSH_MCP_UI_PORT)"),
  },
  async ({ port }) => {
    try {
      const listenPort = port || Number(process.env.CURSOR_SSH_MCP_UI_PORT || 3847);
      const info = await startUiServer(listenPort);
      return text({
        ...info,
        url: getUiUrl(info.port),
        howToOpenPanel:
          "In Cursor: click the SSH icon in the left Activity Bar (or Command Palette → “SSH: Focus Panel”). Drag the sidebar sash to resize; click the icon again or collapse the primary sidebar to hide it. Install the bundled extension from cursor-ssh-mcp/extension if the icon is missing.",
        sharedDataDir: dataDir(),
        hostsFile: hostsPath(),
      });
    } catch (err) {
      return toolError(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
