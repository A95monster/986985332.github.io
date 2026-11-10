import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  expandHome,
  getHost,
  listHostsPublic,
  removeHost,
  upsertHost,
} from "./hosts.js";
import { deleteHostSecret, getHostSecret, setHostSecret } from "./secrets.js";
import {
  closeSession,
  listSessions,
  runCommand,
  withConnection,
} from "./ssh.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.join(__dirname, "..", "ui");
const DEFAULT_PORT = Number(process.env.CURSOR_SSH_MCP_UI_PORT || 3847);

let serverRef = null;
let wssRef = null;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(UI_ROOT, urlPath));
  if (!filePath.startsWith(UI_ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

function hostsForApi() {
  return listHostsPublic((id) => Boolean(getHostSecret(id).password));
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const { pathname } = url;

  try {
    if (req.method === "GET" && pathname === "/api/hosts") {
      return json(res, 200, {
        hosts: hostsForApi(),
        sessions: listSessions(),
        home: os.homedir(),
      });
    }

    if (req.method === "POST" && pathname === "/api/hosts") {
      const body = await readBody(req);
      const host = upsertHost(body);
      if (body.password !== undefined || body.passphrase !== undefined) {
        setHostSecret(host.id, {
          password: body.password,
          passphrase: body.passphrase,
        });
      }
      return json(res, 200, {
        host: sanitizeWithSecret(host.id),
      });
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/hosts/")) {
      const id = decodeURIComponent(pathname.slice("/api/hosts/".length));
      closeSession(id);
      removeHost(id);
      deleteHostSecret(id);
      return json(res, 200, { removed: id });
    }

    if (req.method === "POST" && pathname === "/api/test") {
      const body = await readBody(req);
      const host = getHost(body.id);
      const result = await withConnection(host, true, (conn) =>
        runCommand(conn, "echo ok && whoami && hostname", { timeoutMs: 20000 })
      );
      return json(res, 200, { ok: result.exitCode === 0, ...result });
    }

    if (req.method === "POST" && pathname === "/api/run") {
      const body = await readBody(req);
      const host = getHost(body.id);
      const result = await withConnection(host, true, (conn) =>
        runCommand(conn, body.command, {
          cwd: body.cwd || host.defaultCwd,
          timeoutMs: body.timeoutMs || 60000,
        })
      );
      return json(res, 200, result);
    }

    if (req.method === "GET" && pathname === "/api/local/list") {
      const target = expandHome(url.searchParams.get("path") || os.homedir());
      return json(res, 200, listLocalDir(target));
    }

    if (req.method === "GET" && pathname === "/api/remote/list") {
      const id = url.searchParams.get("id");
      const remotePath = url.searchParams.get("path") || ".";
      const host = getHost(id);
      const listing = await withConnection(host, true, (conn) =>
        sftpList(conn, remotePath)
      );
      return json(res, 200, listing);
    }

    if (req.method === "POST" && pathname === "/api/transfer/upload") {
      const body = await readBody(req);
      const host = getHost(body.id);
      const localPath = expandHome(body.localPath);
      const remotePath = body.remotePath;
      const content = fs.readFileSync(localPath);
      if (content.length > 5 * 1024 * 1024) {
        throw new Error("File too large for upload (max 5 MiB in UI MVP)");
      }
      const written = await withConnection(host, true, (conn) =>
        sftpWriteBinary(conn, remotePath, content)
      );
      return json(res, 200, written);
    }

    if (req.method === "POST" && pathname === "/api/transfer/download") {
      const body = await readBody(req);
      const host = getHost(body.id);
      const remotePath = body.remotePath;
      const localPath = expandHome(body.localPath);
      const data = await withConnection(host, true, (conn) =>
        sftpReadBinary(conn, remotePath, 5 * 1024 * 1024)
      );
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, data.buffer);
      return json(res, 200, {
        localPath,
        bytes: data.buffer.length,
      });
    }

    serveStatic(req, res);
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

function sanitizeWithSecret(id) {
  const host = getHost(id);
  const secret = getHostSecret(id);
  return listHostsPublic(() => Boolean(secret.password)).find((h) => h.id === id) || host;
}

function listLocalDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Local path not found: ${dirPath}`);
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error("Not a directory");
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).map((d) => ({
    name: d.name,
    path: path.join(dirPath, d.name),
    type: d.isDirectory() ? "dir" : "file",
  }));
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return {
    path: dirPath,
    parent: path.dirname(dirPath),
    entries,
  };
}

function sftpList(conn, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.realpath(remotePath, (rpErr, abs) => {
        if (rpErr) {
          sftp.end();
          return reject(rpErr);
        }
        sftp.readdir(abs, (listErr, list) => {
          sftp.end();
          if (listErr) return reject(listErr);
          const entries = list
            .map((item) => ({
              name: item.filename,
              path: abs.replace(/\/$/, "") + "/" + item.filename,
              type: item.attrs.isDirectory() ? "dir" : "file",
              size: item.attrs.size || 0,
            }))
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          const parent =
            abs === "/" ? "/" : abs.replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/";
          resolve({ path: abs, parent, entries });
        });
      });
    });
  });
}

function sftpWriteBinary(conn, remotePath, buffer) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remotePath);
      stream.on("error", (e) => {
        sftp.end();
        reject(e);
      });
      stream.on("close", () => {
        sftp.end();
        resolve({ path: remotePath, bytesWritten: buffer.length });
      });
      stream.end(buffer);
    });
  });
}

function sftpReadBinary(conn, remotePath, maxBytes) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.stat(remotePath, (statErr, stats) => {
        if (statErr) {
          sftp.end();
          return reject(statErr);
        }
        if (stats.size > maxBytes) {
          sftp.end();
          return reject(new Error(`Remote file too large (${stats.size} bytes)`));
        }
        const chunks = [];
        const stream = sftp.createReadStream(remotePath);
        stream.on("data", (c) => chunks.push(c));
        stream.on("error", (e) => {
          sftp.end();
          reject(e);
        });
        stream.on("end", () => {
          const buffer = Buffer.concat(chunks);
          sftp.end();
          resolve({ buffer });
        });
      });
    });
  });
}

function attachShellWs(server) {
  const wss = new WebSocketServer({ server, path: "/ws/shell" });
  wss.on("connection", async (ws, req) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const id = url.searchParams.get("id");
      if (!id) {
        ws.close(1008, "missing host id");
        return;
      }
      const host = getHost(id);
      const { Client } = await import("ssh2");
      const { resolveAuth } = await import("./hosts.js");
      const conn = new Client();
      conn
        .on("ready", () => {
          conn.shell({ term: "xterm-256color" }, (err, stream) => {
            if (err) {
              ws.send(JSON.stringify({ type: "error", message: err.message }));
              ws.close();
              conn.end();
              return;
            }
            ws.send(JSON.stringify({ type: "ready", host: id }));
            stream.on("data", (data) => {
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: "data", data: data.toString("utf8") }));
              }
            });
            stream.stderr.on("data", (data) => {
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: "data", data: data.toString("utf8") }));
              }
            });
            stream.on("close", () => {
              try {
                ws.close();
              } catch {
                /* ignore */
              }
              conn.end();
            });
            ws.on("message", (raw) => {
              try {
                const msg = JSON.parse(String(raw));
                if (msg.type === "input") stream.write(msg.data);
                if (msg.type === "resize" && stream.setWindow) {
                  stream.setWindow(msg.rows || 24, msg.cols || 80, 0, 0);
                }
              } catch {
                stream.write(String(raw));
              }
            });
            ws.on("close", () => {
              try {
                stream.end();
              } catch {
                /* ignore */
              }
              conn.end();
            });
          });
        })
        .on("error", (err) => {
          try {
            ws.send(JSON.stringify({ type: "error", message: err.message }));
          } catch {
            /* ignore */
          }
          ws.close();
        })
        .connect(resolveAuth(host, getHostSecret(host.id)));
    } catch (err) {
      try {
        ws.send(
          JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          })
        );
      } catch {
        /* ignore */
      }
      ws.close();
    }
  });
  return wss;
}

export function getUiUrl(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${port}/`;
}

function probeLocalUi(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/hosts",
        timeout: 600,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function startUiServer(port = DEFAULT_PORT) {
  if (serverRef) {
    return { url: getUiUrl(port), port, alreadyRunning: true };
  }

  // Another process (Cursor extension) may already own the port.
  if (await probeLocalUi(port)) {
    return { url: getUiUrl(port), port, alreadyRunning: true };
  }

  await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => handleApi(req, res));
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      serverRef = server;
      wssRef = attachShellWs(server);
      resolve();
    });
  });

  return { url: getUiUrl(port), port, alreadyRunning: false };
}

export function stopUiServer() {
  if (wssRef) {
    try {
      wssRef.close();
    } catch {
      /* ignore */
    }
    wssRef = null;
  }
  if (serverRef) {
    try {
      serverRef.close();
    } catch {
      /* ignore */
    }
    serverRef = null;
  }
}
