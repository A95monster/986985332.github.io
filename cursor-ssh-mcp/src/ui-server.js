import http from "node:http";
import https from "node:https";
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
/** @type {Map<string, number>} hostId -> open shell websocket count */
const shellOnline = new Map();

function markShellOnline(id) {
  if (!id) return;
  shellOnline.set(id, (shellOnline.get(id) || 0) + 1);
}

function markShellOffline(id) {
  if (!id) return;
  const n = (shellOnline.get(id) || 0) - 1;
  if (n <= 0) shellOnline.delete(id);
  else shellOnline.set(id, n);
}

function listShellOnline() {
  return [...shellOnline.keys()];
}

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
  // /hosts 与 /work 都返回同一套 UI，由前端按路径切换面板
  if (urlPath === "/" || urlPath === "/hosts" || urlPath === "/work") {
    urlPath = "/index.html";
  }
  const filePath = path.normalize(path.join(UI_ROOT, urlPath));
  if (!filePath.startsWith(UI_ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function hostsForApi() {
  return listHostsPublic((id) => Boolean(getHostSecret(id).password));
}

function normalizeCheatTopic(raw) {
  const q = String(raw || "").trim();
  const cnMap = {
    导出sql: "mysqldump",
    导出: "mysqldump",
    导入sql: "mysql",
    查端口: "ss",
    看日志: "tail",
    内存: "free",
    进程: "ps",
    压缩: "tar",
    增量同步: "rsync",
    同步: "rsync",
  };
  if (cnMap[q] || cnMap[q.toLowerCase()]) return cnMap[q] || cnMap[q.toLowerCase()];
  const embedded = q.match(/[a-zA-Z][\w.+-]*/);
  if (embedded) return embedded[0].toLowerCase();
  const first = q.split(/\s+/)[0] || "";
  if (/^[a-zA-Z][\w.+-]*$/.test(first)) return first.toLowerCase();
  return "";
}

function fetchCheatSh(topic) {
  // cheat.sh 路径必须是明文命令名，不要 encode 整段，否则会 Unknown topic
  const safe = String(topic || "").replace(/[^\w.+-]/g, "");
  if (!safe) {
    return Promise.reject(new Error("无效命令主题"));
  }
  const pathName = `/${safe}?T`; // T = plain text
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: "cheat.sh",
        path: pathName,
        headers: {
          "User-Agent": "curl/8.0",
          Accept: "text/plain",
        },
        timeout: 12000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8").trim();
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(body || `cheat.sh HTTP ${res.statusCode}`));
            return;
          }
          if (/unknown topic/i.test(body)) {
            reject(new Error(`cheat.sh 没有「${safe}」这条命令，换个英文命令名再试（如 rsync / tar / ss）`));
            return;
          }
          resolve(body || "未查询到内容");
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("联网查询超时"));
    });
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const { pathname } = url;

  try {
    if (req.method === "GET" && pathname === "/api/hosts") {
      const sessions = [...new Set([...listSessions(), ...listShellOnline()])];
      return json(res, 200, {
        hosts: hostsForApi(),
        sessions,
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

    // 本地字典未命中时，代理查询 cheat.sh（避免浏览器 CORS）
    if (req.method === "GET" && pathname === "/api/cheat") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q || q.length > 80) {
        return json(res, 400, { error: "invalid query" });
      }
      const topic = normalizeCheatTopic(q);
      if (!topic) {
        return json(res, 400, {
          error: "请改用英文命令名查询（如 rsync、mysqldump、tar）",
        });
      }
      const text = await fetchCheatSh(topic);
      return json(res, 200, {
        query: q,
        topic,
        source: "cheat.sh",
        url: `https://cheat.sh/${topic}`,
        text,
      });
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
      const written = await withConnection(host, true, (conn) =>
        sftpUploadStream(conn, localPath, remotePath)
      );
      return json(res, 200, written);
    }

    // 同连接批量上传：NDJSON 进度流（并发 + fastPut + 重试）
    if (req.method === "POST" && pathname === "/api/transfer/upload-batch") {
      const body = await readBody(req);
      const host = getHost(body.id);
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) throw new Error("没有待上传文件");
      const wantStream = String(req.headers.accept || "").includes("ndjson") || body.stream === true;
      if (wantStream) {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        const writeEvent = (obj) => {
          if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`);
        };
        try {
          const result = await withConnection(host, true, (conn) =>
            sftpUploadBatch(conn, files, { onEvent: writeEvent })
          );
          writeEvent({ type: "done", ...result });
        } catch (err) {
          writeEvent({
            type: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        res.end();
        return;
      }
      const result = await withConnection(host, true, (conn) =>
        sftpUploadBatch(conn, files, {})
      );
      return json(res, 200, result);
    }

    if (req.method === "POST" && pathname === "/api/transfer/download") {
      const body = await readBody(req);
      const host = getHost(body.id);
      const remotePath = body.remotePath;
      const localPath = expandHome(body.localPath);
      const data = await withConnection(host, true, (conn) =>
        sftpDownloadStream(conn, remotePath, localPath)
      );
      return json(res, 200, data);
    }

    // 同连接批量下载：NDJSON 进度流
    if (req.method === "POST" && pathname === "/api/transfer/download-batch") {
      const body = await readBody(req);
      const host = getHost(body.id);
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) throw new Error("没有待下载文件");
      const wantStream = String(req.headers.accept || "").includes("ndjson") || body.stream === true;
      if (wantStream) {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        const writeEvent = (obj) => {
          if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`);
        };
        try {
          const result = await withConnection(host, true, (conn) =>
            sftpDownloadBatch(conn, files, { onEvent: writeEvent })
          );
          writeEvent({ type: "done", ...result });
        } catch (err) {
          writeEvent({
            type: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        res.end();
        return;
      }
      const result = await withConnection(host, true, (conn) =>
        sftpDownloadBatch(conn, files, {})
      );
      return json(res, 200, result);
    }

    // 主机 A → 主机 B（经本机临时文件中转，流式；单文件兼容）
    if (req.method === "POST" && pathname === "/api/transfer/relay") {
      const body = await readBody(req);
      const fromHost = getHost(body.fromId);
      const toHost = getHost(body.toId);
      if (fromHost.id === toHost.id && body.fromPath === body.toPath) {
        throw new Error("源与目标相同");
      }
      const wantStream = String(req.headers.accept || "").includes("ndjson") || body.stream === true;
      const items = [{ fromPath: body.fromPath, toPath: body.toPath }];
      if (wantStream) {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        const writeEvent = (obj) => {
          if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`);
        };
        try {
          const result = await sftpRelayBatch(fromHost, toHost, items, { onEvent: writeEvent });
          writeEvent({ type: "done", ...result });
        } catch (err) {
          writeEvent({
            type: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        res.end();
        return;
      }
      const result = await sftpRelayBatch(fromHost, toHost, items, {});
      return json(res, 200, result);
    }

    // 主机 A → 主机 B 批量（支持目录，并发中转）
    if (req.method === "POST" && pathname === "/api/transfer/relay-batch") {
      const body = await readBody(req);
      const fromHost = getHost(body.fromId);
      const toHost = getHost(body.toId);
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) throw new Error("没有待中转文件");
      const wantStream = String(req.headers.accept || "").includes("ndjson") || body.stream === true;
      if (wantStream) {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        const writeEvent = (obj) => {
          if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`);
        };
        try {
          const result = await sftpRelayBatch(fromHost, toHost, files, { onEvent: writeEvent });
          writeEvent({ type: "done", ...result });
        } catch (err) {
          writeEvent({
            type: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        res.end();
        return;
      }
      const result = await sftpRelayBatch(fromHost, toHost, files, {});
      return json(res, 200, result);
    }

    if (req.method === "POST" && pathname === "/api/fs/mkdir") {
      const body = await readBody(req);
      if (body.scope === "local") {
        const dir = expandHome(body.path);
        fs.mkdirSync(dir, { recursive: true });
        return json(res, 200, { path: dir });
      }
      const host = getHost(body.id);
      await withConnection(host, true, (conn) => sftpMkdir(conn, body.path));
      return json(res, 200, { path: body.path });
    }

    if (req.method === "POST" && pathname === "/api/fs/rename") {
      const body = await readBody(req);
      if (body.scope === "local") {
        const from = expandHome(body.from);
        const to = expandHome(body.to);
        fs.renameSync(from, to);
        return json(res, 200, { from, to });
      }
      const host = getHost(body.id);
      await withConnection(host, true, (conn) => sftpRename(conn, body.from, body.to));
      return json(res, 200, { from: body.from, to: body.to });
    }

    if (req.method === "POST" && pathname === "/api/fs/delete") {
      const body = await readBody(req);
      if (body.scope === "local") {
        const target = expandHome(body.path);
        const st = fs.lstatSync(target);
        if (st.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.unlinkSync(target);
        return json(res, 200, { path: target });
      }
      const host = getHost(body.id);
      await withConnection(host, true, (conn) => sftpDelete(conn, body.path, body.isDir));
      return json(res, 200, { path: body.path });
    }

    if (req.method === "POST" && pathname === "/api/fs/chmod") {
      const body = await readBody(req);
      const mode = parseInt(String(body.mode), 8);
      if (!Number.isFinite(mode)) throw new Error("权限格式无效，请用如 755");
      if (body.scope === "local") {
        const target = expandHome(body.path);
        fs.chmodSync(target, mode);
        return json(res, 200, { path: target, mode: body.mode });
      }
      const host = getHost(body.id);
      await withConnection(host, true, (conn) => sftpChmod(conn, body.path, mode));
      return json(res, 200, { path: body.path, mode: body.mode });
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

function modeToPerm(mode, isDir) {
  const m = mode & 0o777;
  const chars = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  const u = chars[(m >> 6) & 7];
  const g = chars[(m >> 3) & 7];
  const o = chars[m & 7];
  return `${isDir ? "d" : "-"}${u}${g}${o}`;
}

function fileKind(name, isDir) {
  if (isDir) return "文件夹";
  const ext = path.extname(name).replace(/^\./, "").toLowerCase();
  if (!ext) return "文件";
  const map = {
    txt: "文本",
    md: "Markdown",
    log: "日志",
    json: "JSON",
    js: "JavaScript",
    ts: "TypeScript",
    py: "Python",
    java: "Java",
    sh: "Shell",
    sql: "SQL",
    yml: "YAML",
    yaml: "YAML",
    xml: "XML",
    html: "HTML",
    css: "CSS",
    png: "图片",
    jpg: "图片",
    jpeg: "图片",
    gif: "图片",
    svg: "图片",
    zip: "压缩包",
    gz: "压缩包",
    tgz: "压缩包",
    tar: "压缩包",
    jar: "JAR",
    war: "WAR",
    conf: "配置",
    cfg: "配置",
    ini: "配置",
    env: "环境变量",
  };
  return map[ext] || ext;
}

function listLocalDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Local path not found: ${dirPath}`);
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error("Not a directory");
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).map((d) => {
    const full = path.join(dirPath, d.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      st = null;
    }
    const isDir = d.isDirectory();
    const mode = st ? st.mode : 0;
    return {
      name: d.name,
      path: full,
      type: isDir ? "dir" : "file",
      size: isDir ? 0 : st?.size || 0,
      mtime: st ? Math.floor(st.mtimeMs) : 0,
      mode,
      perm: modeToPerm(mode, isDir),
      kind: fileKind(d.name, isDir),
      hidden: d.name.startsWith("."),
    };
  });
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

function getSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function walkLocalFiles(rootDir) {
  /** @type {{ localPath: string, relPath: string, size: number }[]} */
  const files = [];
  /** @type {string[]} */
  const dirs = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      throw new Error(`无法读取本地目录: ${abs} (${err instanceof Error ? err.message : String(err)})`);
    }
    for (const d of entries) {
      if (d.name === "." || d.name === "..") continue;
      const childAbs = path.join(abs, d.name);
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      let isDir = d.isDirectory();
      let isFile = d.isFile();
      if (d.isSymbolicLink()) {
        try {
          const st = fs.statSync(childAbs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        dirs.push(childRel);
        walk(childAbs, childRel);
      } else if (isFile) {
        let size = 0;
        try {
          size = fs.statSync(childAbs).size || 0;
        } catch {
          size = 0;
        }
        files.push({ localPath: childAbs, relPath: childRel, size });
      }
    }
  };
  walk(rootDir, "");
  return { files, dirs };
}

function sftpMkdirp(sftp, remotePath) {
  const normalized = String(remotePath || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized === "/" || normalized === ".") {
    return Promise.resolve();
  }
  const parts = normalized.split("/").filter(Boolean);
  const isAbs = normalized.startsWith("/");
  return new Promise((resolve, reject) => {
    let i = 0;
    let current = isAbs ? "" : ".";
    const next = () => {
      if (i >= parts.length) return resolve();
      current = current === "." ? parts[i] : `${current}/${parts[i]}`;
      if (isAbs && !current.startsWith("/")) current = `/${current}`;
      i += 1;
      sftp.mkdir(current, (err) => {
        // 已存在则忽略
        if (err && err.code !== 4 && !/Failure|exists|already/i.test(String(err.message || err))) {
          // ssh2 often uses code 4 for failure when dir exists; also try stat
          sftp.stat(current, (stErr, st) => {
            if (!stErr && st && st.isDirectory()) return next();
            reject(err);
          });
          return;
        }
        next();
      });
    };
    next();
  });
}

function sftpReaddir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => (err ? reject(err) : resolve(list || [])));
  });
}

function sftpStat(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, st) => (err ? reject(err) : resolve(st)));
  });
}

async function walkRemoteFiles(sftp, rootDir) {
  /** @type {{ remotePath: string, relPath: string, size: number }[]} */
  const files = [];
  /** @type {string[]} */
  const dirs = [];
  const walk = async (abs, rel) => {
    const list = await sftpReaddir(sftp, abs);
    for (const item of list) {
      if (!item || item.filename === "." || item.filename === "..") continue;
      const childAbs = `${String(abs).replace(/\/+$/, "")}/${item.filename}`;
      const childRel = rel ? `${rel}/${item.filename}` : item.filename;
      const isDir = item.attrs?.isDirectory?.() || false;
      const isFile = item.attrs?.isFile?.() || (!isDir && !item.attrs?.isSymbolicLink?.());
      if (isDir) {
        dirs.push(childRel);
        await walk(childAbs, childRel);
      } else if (isFile || item.attrs?.isSymbolicLink?.()) {
        let size = item.attrs?.size || 0;
        if (item.attrs?.isSymbolicLink?.()) {
          try {
            const st = await sftpStat(sftp, childAbs);
            if (st.isDirectory()) {
              dirs.push(childRel);
              await walk(childAbs, childRel);
              continue;
            }
            size = st.size || 0;
          } catch {
            continue;
          }
        }
        files.push({ remotePath: childAbs, relPath: childRel, size });
      }
    }
  };
  await walk(rootDir, "");
  return { files, dirs };
}

function joinRemote(base, rel) {
  const b = String(base || "").replace(/\/+$/, "");
  const r = String(rel || "").replace(/^\/+/, "");
  if (!r) return b || "/";
  if (!b || b === ".") return r;
  return `${b}/${r}`;
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
            .map((item) => {
              const isDir = item.attrs.isDirectory();
              const mode = item.attrs.mode || 0;
              return {
                name: item.filename,
                path: abs.replace(/\/$/, "") + "/" + item.filename,
                type: isDir ? "dir" : "file",
                size: isDir ? 0 : item.attrs.size || 0,
                mtime: (item.attrs.mtime || 0) * 1000,
                mode,
                perm: modeToPerm(mode, isDir),
                kind: fileKind(item.filename, isDir),
                hidden: item.filename.startsWith("."),
              };
            })
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

/** 传输参数：多文件并发 + 单文件分块并发，按体积自适应 */
const TRANSFER_OPTS = {
  chunkSize: 512 * 1024,
  /** 单文件内部并发块数（ssh2 fastPut/fastGet） */
  chunkConcurrency: 8,
  /** 同时传输的文件数（默认） */
  fileConcurrency: 8,
  /** 大量小文件时的文件并发 */
  fileConcurrencyMany: 12,
  retries: 3,
  /** 超过该大小视为大文件：降低文件并发，提高单文件分块 */
  largeFileBytes: 32 * 1024 * 1024,
  /** 小于该大小视为小文件：可提高文件并发 */
  smallFileBytes: 2 * 1024 * 1024,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, retries = TRANSFER_OPTS.retries) {
  let last;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      last = err;
      if (attempt >= retries - 1) break;
      await sleep(250 * 2 ** attempt);
    }
  }
  throw last;
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

function pickFileConcurrency(filesMeta) {
  const n = filesMeta.length;
  if (n <= 1) return 1;
  const largeCount = filesMeta.filter((f) => (f.size || 0) >= TRANSFER_OPTS.largeFileBytes).length;
  const allSmall = filesMeta.every((f) => (f.size || 0) < TRANSFER_OPTS.smallFileBytes);
  // 全是大文件：少并发、留给单文件分块
  if (largeCount === n) return Math.min(2, n);
  // 混有大文件：中等并发
  if (largeCount > 0) return Math.min(4, n);
  // 大量小文件：提高并发，吃满管道
  if (allSmall && n >= 16) return Math.min(TRANSFER_OPTS.fileConcurrencyMany, n);
  return Math.min(TRANSFER_OPTS.fileConcurrency, n);
}

function pickChunkConcurrency(fileConcurrency, fileSize) {
  if ((fileSize || 0) >= TRANSFER_OPTS.largeFileBytes) return TRANSFER_OPTS.chunkConcurrency;
  // 文件并发高时，降低单文件分块并发，避免 SSH 通道拥塞
  if (fileConcurrency >= 10) return 3;
  if (fileConcurrency >= 6) return 4;
  if (fileConcurrency >= 4) return 6;
  return TRANSFER_OPTS.chunkConcurrency;
}

function sftpFastPut(sftp, localPath, remotePath, onStep, opts = {}) {
  const concurrency = opts.concurrency || TRANSFER_OPTS.chunkConcurrency;
  const chunkSize = opts.chunkSize || TRANSFER_OPTS.chunkSize;
  return new Promise((resolve, reject) => {
    sftp.fastPut(
      localPath,
      remotePath,
      {
        concurrency,
        chunkSize,
        step: (transferred, _chunk, total) => {
          if (typeof onStep === "function") onStep(transferred, total || 0);
        },
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function sftpFastGet(sftp, remotePath, localPath, onStep, opts = {}) {
  const concurrency = opts.concurrency || TRANSFER_OPTS.chunkConcurrency;
  const chunkSize = opts.chunkSize || TRANSFER_OPTS.chunkSize;
  return new Promise((resolve, reject) => {
    sftp.fastGet(
      remotePath,
      localPath,
      {
        concurrency,
        chunkSize,
        step: (transferred, _chunk, total) => {
          if (typeof onStep === "function") onStep(transferred, total || 0);
        },
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function sftpUploadStream(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(localPath)) {
      reject(new Error(`本地文件不存在: ${localPath}`));
      return;
    }
    const size = fs.statSync(localPath).size;
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      withRetry(() => sftpFastPut(sftp, localPath, remotePath))
        .then(() => {
          try {
            sftp.end();
          } catch {
            /* ignore */
          }
          resolve({ path: remotePath, bytesWritten: size });
        })
        .catch((e) => {
          try {
            sftp.end();
          } catch {
            /* ignore */
          }
          reject(e);
        });
    });
  });
}

async function sftpUploadBatch(conn, files, { onEvent } = {}) {
  const sftp = await getSftp(conn);
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  const prepared = [];
  const remoteDirs = new Set();
  for (const f of files) {
    const localPath = expandHome(f.localPath);
    const remotePath = f.remotePath;
    if (!fs.existsSync(localPath)) {
      throw new Error(`本地文件不存在: ${localPath}`);
    }
    const st = fs.statSync(localPath);
    if (st.isDirectory()) {
      remoteDirs.add(remotePath.replace(/\/+$/, ""));
      const walked = walkLocalFiles(localPath);
      for (const d of walked.dirs) remoteDirs.add(joinRemote(remotePath, d));
      for (const file of walked.files) {
        prepared.push({
          localPath: file.localPath,
          remotePath: joinRemote(remotePath, file.relPath),
          name: file.relPath || path.basename(file.localPath),
          size: file.size,
        });
      }
      continue;
    }
    const parent = path.posix.dirname(String(remotePath).replace(/\\/g, "/"));
    if (parent && parent !== "." && parent !== "/") remoteDirs.add(parent);
    prepared.push({
      localPath,
      remotePath,
      name: path.basename(localPath),
      size: st.size,
    });
  }
  // 按深度分层建目录，同层可并发
  const dirsSorted = [...remoteDirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  let depth = -1;
  let batch = [];
  const flushDirs = async () => {
    if (!batch.length) return;
    await mapPool(batch, Math.min(6, batch.length), async (dir) => sftpMkdirp(sftp, dir));
    batch = [];
  };
  for (const dir of dirsSorted) {
    const d = String(dir).split("/").filter(Boolean).length;
    if (d !== depth) {
      await flushDirs();
      depth = d;
    }
    batch.push(dir);
  }
  await flushDirs();

  if (!prepared.length) {
    emit({ type: "start", totalFiles: 0, totalBytes: 0, direction: "upload", concurrency: 0 });
    return { count: 0, bytes: 0, files: [], elapsedMs: 0, concurrency: 0 };
  }
  // 小文件优先，尽快拉高并发吞吐
  prepared.sort((a, b) => (a.size || 0) - (b.size || 0));
  const totalBytes = prepared.reduce((s, f) => s + f.size, 0);
  const totalFiles = prepared.length;
  const concurrency = pickFileConcurrency(prepared);
  emit({ type: "start", totalFiles, totalBytes, direction: "upload", concurrency });

  let completedFiles = 0;
  let completedBytes = 0;
  const inflight = new Map(); // idx -> transferred
  const startedAt = Date.now();

  const flushProgress = (idx, name, transferred, size) => {
    inflight.set(idx, transferred);
    let live = 0;
    for (const v of inflight.values()) live += v;
    const transferredBytes = completedBytes + live;
    const elapsed = Math.max(1, Date.now() - startedAt);
    emit({
      type: "progress",
      index: idx,
      name,
      fileTransferred: transferred,
      fileTotal: size,
      transferredBytes,
      totalBytes,
      completedFiles,
      totalFiles,
      concurrency,
      speedBps: Math.round((transferredBytes * 1000) / elapsed),
    });
  };

  try {
    const results = await mapPool(prepared, concurrency, async (f, idx) => {
      emit({
        type: "file-start",
        index: idx,
        name: f.name,
        size: f.size,
        remotePath: f.remotePath,
      });
      inflight.set(idx, 0);
      let lastStep = 0;
      const chunkConc = pickChunkConcurrency(concurrency, f.size);
      await withRetry(async (attempt) => {
        if (attempt > 0) {
          emit({ type: "retry", index: idx, name: f.name, attempt: attempt + 1 });
          inflight.set(idx, 0);
        }
        await sftpFastPut(
          sftp,
          f.localPath,
          f.remotePath,
          (transferred, total) => {
            const size = total || f.size;
            if (transferred - lastStep >= TRANSFER_OPTS.chunkSize || transferred >= size) {
              lastStep = transferred;
              flushProgress(idx, f.name, transferred, size);
            }
          },
          { concurrency: chunkConc }
        );
      });
      inflight.delete(idx);
      completedFiles += 1;
      completedBytes += f.size;
      const elapsed = Math.max(1, Date.now() - startedAt);
      const item = { path: f.remotePath, bytesWritten: f.size, name: f.name };
      emit({
        type: "file-done",
        index: idx,
        name: f.name,
        bytesWritten: f.size,
        completedFiles,
        totalFiles,
        transferredBytes: completedBytes,
        totalBytes,
        concurrency,
        speedBps: Math.round((completedBytes * 1000) / elapsed),
      });
      return item;
    });
    return {
      count: results.length,
      bytes: totalBytes,
      files: results,
      elapsedMs: Date.now() - startedAt,
      concurrency,
    };
  } finally {
    try {
      sftp.end();
    } catch {
      /* ignore */
    }
  }
}

function sftpDownloadStream(conn, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      withRetry(() => sftpFastGet(sftp, remotePath, localPath))
        .then(() => {
          let bytes = 0;
          try {
            bytes = fs.statSync(localPath).size;
          } catch {
            /* ignore */
          }
          try {
            sftp.end();
          } catch {
            /* ignore */
          }
          resolve({ localPath, bytes });
        })
        .catch((e) => {
          try {
            sftp.end();
          } catch {
            /* ignore */
          }
          reject(e);
        });
    });
  });
}

async function sftpDownloadBatch(conn, files, { onEvent } = {}) {
  const sftp = await getSftp(conn);
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  const prepared = [];
  for (const f of files) {
    const remotePath = f.remotePath;
    const localPath = expandHome(f.localPath);
    let st;
    try {
      st = await sftpStat(sftp, remotePath);
    } catch (err) {
      throw new Error(`远程路径不存在: ${remotePath} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (st.isDirectory()) {
      fs.mkdirSync(localPath, { recursive: true });
      const walked = await walkRemoteFiles(sftp, remotePath);
      for (const d of walked.dirs) {
        fs.mkdirSync(path.join(localPath, d), { recursive: true });
      }
      for (const file of walked.files) {
        prepared.push({
          remotePath: file.remotePath,
          localPath: path.join(localPath, file.relPath),
          name: file.relPath || path.basename(file.remotePath),
          size: file.size,
        });
      }
      continue;
    }
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    prepared.push({
      remotePath,
      localPath,
      name: path.basename(remotePath),
      size: st.size || 0,
    });
  }
  if (!prepared.length) {
    emit({ type: "start", totalFiles: 0, totalBytes: 0, direction: "download", concurrency: 0 });
    return { count: 0, bytes: 0, files: [], elapsedMs: 0, concurrency: 0 };
  }
  for (const f of prepared) {
    fs.mkdirSync(path.dirname(f.localPath), { recursive: true });
  }
  prepared.sort((a, b) => (a.size || 0) - (b.size || 0));
  const totalBytes = prepared.reduce((s, f) => s + f.size, 0);
  const totalFiles = prepared.length;
  const concurrency = pickFileConcurrency(prepared);
  emit({ type: "start", totalFiles, totalBytes, direction: "download", concurrency });

  let completedFiles = 0;
  let completedBytes = 0;
  const inflight = new Map();
  const startedAt = Date.now();

  const flushProgress = (idx, name, transferred, size) => {
    inflight.set(idx, transferred);
    let live = 0;
    for (const v of inflight.values()) live += v;
    const transferredBytes = completedBytes + live;
    const elapsed = Math.max(1, Date.now() - startedAt);
    emit({
      type: "progress",
      index: idx,
      name,
      fileTransferred: transferred,
      fileTotal: size,
      transferredBytes,
      totalBytes,
      completedFiles,
      totalFiles,
      concurrency,
      speedBps: Math.round((transferredBytes * 1000) / elapsed),
    });
  };

  try {
    const results = await mapPool(prepared, concurrency, async (f, idx) => {
      emit({
        type: "file-start",
        index: idx,
        name: f.name,
        size: f.size,
        localPath: f.localPath,
      });
      inflight.set(idx, 0);
      let lastStep = 0;
      const chunkConc = pickChunkConcurrency(concurrency, f.size);
      await withRetry(async (attempt) => {
        if (attempt > 0) {
          emit({ type: "retry", index: idx, name: f.name, attempt: attempt + 1 });
          inflight.set(idx, 0);
        }
        await sftpFastGet(
          sftp,
          f.remotePath,
          f.localPath,
          (transferred, total) => {
            const size = total || f.size;
            if (transferred - lastStep >= TRANSFER_OPTS.chunkSize || transferred >= size) {
              lastStep = transferred;
              flushProgress(idx, f.name, transferred, size);
            }
          },
          { concurrency: chunkConc }
        );
      });
      inflight.delete(idx);
      let bytes = f.size;
      try {
        bytes = fs.statSync(f.localPath).size;
      } catch {
        /* ignore */
      }
      completedFiles += 1;
      completedBytes += bytes;
      const elapsed = Math.max(1, Date.now() - startedAt);
      const item = { localPath: f.localPath, bytes, name: f.name };
      emit({
        type: "file-done",
        index: idx,
        name: f.name,
        bytesWritten: bytes,
        completedFiles,
        totalFiles,
        transferredBytes: completedBytes,
        totalBytes: totalBytes || completedBytes,
        concurrency,
        speedBps: Math.round((completedBytes * 1000) / elapsed),
      });
      return item;
    });
    return {
      count: results.length,
      bytes: results.reduce((s, r) => s + (r.bytes || 0), 0),
      files: results,
      elapsedMs: Date.now() - startedAt,
      concurrency,
    };
  } finally {
    try {
      sftp.end();
    } catch {
      /* ignore */
    }
  }
}

/** 主机 A → 主机 B：展开目录后经本机临时目录并发中转 */
async function sftpRelayBatch(fromHost, toHost, items, { onEvent } = {}) {
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  const tmpRoot = path.join(
    os.tmpdir(),
    `ssh-mcp-relay-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  fs.mkdirSync(tmpRoot, { recursive: true });
  try {
    const downloadPayload = items.map((it, i) => ({
      remotePath: it.fromPath,
      localPath: path.join(tmpRoot, `item-${i}-${path.basename(it.fromPath) || "bin"}`),
      toPath: it.toPath,
    }));
    // 先整包下载（支持目录展开）
    const dlMap = downloadPayload.map((d) => ({
      remotePath: d.remotePath,
      localPath: d.localPath,
    }));
    let localFiles = [];
    await withConnection(fromHost, true, async (conn) => {
      // 复用 download batch 展开，但要记住每个根到 toPath 的映射
      const sftp = await getSftp(conn);
      try {
        for (let i = 0; i < downloadPayload.length; i++) {
          const d = downloadPayload[i];
          const st = await sftpStat(sftp, d.remotePath);
          if (st.isDirectory()) {
            fs.mkdirSync(d.localPath, { recursive: true });
            const walked = await walkRemoteFiles(sftp, d.remotePath);
            for (const dir of walked.dirs) {
              fs.mkdirSync(path.join(d.localPath, dir), { recursive: true });
            }
            for (const file of walked.files) {
              localFiles.push({
                localPath: path.join(d.localPath, file.relPath),
                remotePath: joinRemote(d.toPath, file.relPath),
                name: file.relPath || path.basename(file.remotePath),
                size: file.size,
                _remoteSrc: file.remotePath,
              });
            }
          } else {
            localFiles.push({
              localPath: d.localPath,
              remotePath: d.toPath,
              name: path.basename(d.remotePath),
              size: st.size || 0,
              _remoteSrc: d.remotePath,
            });
          }
        }
      } finally {
        try {
          sftp.end();
        } catch {
          /* ignore */
        }
      }
      // 并发拉取
      if (localFiles.length) {
        const prepared = localFiles.map((f) => ({
          remotePath: f._remoteSrc,
          localPath: f.localPath,
          name: f.name,
          size: f.size,
        }));
        for (const f of prepared) fs.mkdirSync(path.dirname(f.localPath), { recursive: true });
        const sftp2 = await getSftp(conn);
        const conc = pickFileConcurrency(prepared);
        try {
          await mapPool(prepared, conc, async (f) => {
            const chunkConc = pickChunkConcurrency(conc, f.size);
            await withRetry(() =>
              sftpFastGet(sftp2, f.remotePath, f.localPath, null, { concurrency: chunkConc })
            );
            try {
              f.size = fs.statSync(f.localPath).size;
            } catch {
              /* ignore */
            }
          });
        } finally {
          try {
            sftp2.end();
          } catch {
            /* ignore */
          }
        }
        // sync sizes back
        localFiles = localFiles.map((f, idx) => ({
          ...f,
          size: prepared[idx].size || f.size,
        }));
      }
    });

    if (!localFiles.length) {
      emit({ type: "start", totalFiles: 0, totalBytes: 0, direction: "relay", concurrency: 0 });
      return { count: 0, bytes: 0, files: [], elapsedMs: 0, concurrency: 0 };
    }

    const uploadFiles = localFiles.map((f) => ({
      localPath: f.localPath,
      remotePath: f.remotePath,
    }));
    const result = await withConnection(toHost, true, (conn) =>
      sftpUploadBatch(conn, uploadFiles, { onEvent })
    );
    return {
      ...result,
      fromId: fromHost.id,
      toId: toHost.id,
    };
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function sftpMkdir(conn, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.mkdir(remotePath, (e) => {
        sftp.end();
        if (e) reject(e);
        else resolve(true);
      });
    });
  });
}

function sftpRename(conn, from, to) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.rename(from, to, (e) => {
        sftp.end();
        if (e) reject(e);
        else resolve(true);
      });
    });
  });
}

function sftpUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => (err ? reject(err) : resolve()));
  });
}

function sftpRmdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.rmdir(remotePath, (err) => (err ? reject(err) : resolve()));
  });
}

async function sftpDeleteRecursive(sftp, remotePath) {
  let st;
  try {
    st = await sftpStat(sftp, remotePath);
  } catch (err) {
    throw new Error(
      `无法删除「${remotePath}」：路径不存在或无权限（${err instanceof Error ? err.message : String(err)}）`
    );
  }
  if (st.isDirectory()) {
    const list = await sftpReaddir(sftp, remotePath);
    for (const item of list) {
      if (!item || item.filename === "." || item.filename === "..") continue;
      const child = `${String(remotePath).replace(/\/+$/, "")}/${item.filename}`;
      await sftpDeleteRecursive(sftp, child);
    }
    await sftpRmdir(sftp, remotePath);
    return { path: remotePath, type: "dir" };
  }
  await sftpUnlink(sftp, remotePath);
  return { path: remotePath, type: "file" };
}

function sftpDelete(conn, remotePath, _isDirHint) {
  return new Promise((resolve, reject) => {
    conn.sftp(async (err, sftp) => {
      if (err) return reject(err);
      try {
        // 不信任客户端 isDir：先 stat，目录递归删，文件 unlink
        const result = await sftpDeleteRecursive(sftp, remotePath);
        try {
          sftp.end();
        } catch {
          /* ignore */
        }
        resolve(result);
      } catch (e) {
        try {
          sftp.end();
        } catch {
          /* ignore */
        }
        reject(e);
      }
    });
  });
}

function sftpChmod(conn, remotePath, mode) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.chmod(remotePath, mode, (e) => {
        sftp.end();
        if (e) reject(e);
        else resolve(true);
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
      const auth = resolveAuth(host, getHostSecret(host.id));
      const conn = new Client();
      let finished = false;
      const sendErr = (message) => {
        if (finished) return;
        finished = true;
        try {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "error", message: String(message || "连接失败") }));
          }
        } catch {
          /* ignore */
        }
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        try {
          conn.end();
        } catch {
          /* ignore */
        }
      };
      const connectTimer = setTimeout(() => {
        sendErr(
          `SSH connect timeout to ${host.host}:${host.port || 22} (${Math.round((auth.readyTimeout || 20000) / 1000)}s)`
        );
      }, auth.readyTimeout || 20000);
      conn
        .on("ready", () => {
          clearTimeout(connectTimer);
          conn.shell({ term: "xterm-256color" }, (err, stream) => {
            if (err) {
              sendErr(err.message || "无法打开远程 Shell");
              return;
            }
            if (finished) {
              try {
                stream.end();
              } catch {
                /* ignore */
              }
              conn.end();
              return;
            }
            finished = true;
            markShellOnline(id);
            let shellCounted = true;
            const dropShell = () => {
              if (!shellCounted) return;
              shellCounted = false;
              markShellOffline(id);
            };
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
              dropShell();
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
              dropShell();
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
          clearTimeout(connectTimer);
          sendErr(err?.message || "SSH 连接失败");
        })
        .connect(auth);
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
