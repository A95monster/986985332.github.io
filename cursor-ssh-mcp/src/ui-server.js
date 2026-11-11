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

    // 主机 A → 主机 B（经本机临时文件中转，流式）
    if (req.method === "POST" && pathname === "/api/transfer/relay") {
      const body = await readBody(req);
      const fromHost = getHost(body.fromId);
      const toHost = getHost(body.toId);
      if (fromHost.id === toHost.id && body.fromPath === body.toPath) {
        throw new Error("源与目标相同");
      }
      const tmp = path.join(
        os.tmpdir(),
        `ssh-mcp-relay-${Date.now()}-${Math.random().toString(16).slice(2)}`
      );
      try {
        await withConnection(fromHost, true, (conn) =>
          sftpDownloadStream(conn, body.fromPath, tmp)
        );
        const written = await withConnection(toHost, true, (conn) =>
          sftpUploadStream(conn, tmp, body.toPath)
        );
        return json(res, 200, {
          fromId: fromHost.id,
          toId: toHost.id,
          toPath: body.toPath,
          bytes: written.bytesWritten || written.bytes || 0,
        });
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
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

/** 传输参数：大文件走并行分块，多文件有限并发，失败自动重试 */
const TRANSFER_OPTS = {
  chunkSize: 256 * 1024,
  /** 单文件内部并发块数（ssh2 fastPut/fastGet） */
  chunkConcurrency: 8,
  /** 同时传输的文件数 */
  fileConcurrency: 3,
  retries: 3,
  /** 超过该大小时降低文件并发，把带宽留给单文件分块 */
  largeFileBytes: 32 * 1024 * 1024,
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
  const hasLarge = filesMeta.some((f) => f.size >= TRANSFER_OPTS.largeFileBytes);
  if (filesMeta.length <= 1) return 1;
  if (hasLarge) return Math.min(2, TRANSFER_OPTS.fileConcurrency);
  return Math.min(TRANSFER_OPTS.fileConcurrency, filesMeta.length);
}

function sftpFastPut(sftp, localPath, remotePath, onStep) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(
      localPath,
      remotePath,
      {
        concurrency: TRANSFER_OPTS.chunkConcurrency,
        chunkSize: TRANSFER_OPTS.chunkSize,
        step: (transferred, _chunk, total) => {
          if (typeof onStep === "function") onStep(transferred, total || 0);
        },
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function sftpFastGet(sftp, remotePath, localPath, onStep) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(
      remotePath,
      localPath,
      {
        concurrency: TRANSFER_OPTS.chunkConcurrency,
        chunkSize: TRANSFER_OPTS.chunkSize,
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
  for (const f of files) {
    const localPath = expandHome(f.localPath);
    const remotePath = f.remotePath;
    if (!fs.existsSync(localPath)) {
      throw new Error(`本地文件不存在: ${localPath}`);
    }
    const st = fs.statSync(localPath);
    if (st.isDirectory()) {
      throw new Error(`暂不支持上传目录: ${localPath}`);
    }
    prepared.push({
      localPath,
      remotePath,
      name: path.basename(localPath),
      size: st.size,
    });
  }
  const totalBytes = prepared.reduce((s, f) => s + f.size, 0);
  const totalFiles = prepared.length;
  emit({ type: "start", totalFiles, totalBytes, direction: "upload" });

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
      speedBps: Math.round((transferredBytes * 1000) / elapsed),
    });
  };

  try {
    const concurrency = pickFileConcurrency(prepared);
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
      await withRetry(async (attempt) => {
        if (attempt > 0) {
          emit({ type: "retry", index: idx, name: f.name, attempt: attempt + 1 });
          inflight.set(idx, 0);
        }
        await sftpFastPut(sftp, f.localPath, f.remotePath, (transferred, total) => {
          const size = total || f.size;
          // 节流：每 ~256KB 或完成时推一次
          if (transferred - lastStep >= TRANSFER_OPTS.chunkSize || transferred >= size) {
            lastStep = transferred;
            flushProgress(idx, f.name, transferred, size);
          }
        });
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
        speedBps: Math.round((completedBytes * 1000) / elapsed),
      });
      return item;
    });
    return {
      count: results.length,
      bytes: totalBytes,
      files: results,
      elapsedMs: Date.now() - startedAt,
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
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const size = await new Promise((resolve) => {
      sftp.stat(remotePath, (err, st) => {
        if (err || !st) return resolve(0);
        resolve(st.size || 0);
      });
    });
    prepared.push({
      remotePath,
      localPath,
      name: path.basename(remotePath),
      size,
    });
  }
  const totalBytes = prepared.reduce((s, f) => s + f.size, 0);
  const totalFiles = prepared.length;
  emit({ type: "start", totalFiles, totalBytes, direction: "download" });

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
      speedBps: Math.round((transferredBytes * 1000) / elapsed),
    });
  };

  try {
    const concurrency = pickFileConcurrency(prepared);
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
      await withRetry(async (attempt) => {
        if (attempt > 0) {
          emit({ type: "retry", index: idx, name: f.name, attempt: attempt + 1 });
          inflight.set(idx, 0);
        }
        await sftpFastGet(sftp, f.remotePath, f.localPath, (transferred, total) => {
          const size = total || f.size;
          if (transferred - lastStep >= TRANSFER_OPTS.chunkSize || transferred >= size) {
            lastStep = transferred;
            flushProgress(idx, f.name, transferred, size);
          }
        });
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
        speedBps: Math.round((completedBytes * 1000) / elapsed),
      });
      return item;
    });
    return {
      count: results.length,
      bytes: results.reduce((s, r) => s + (r.bytes || 0), 0),
      files: results,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    try {
      sftp.end();
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

function sftpDelete(conn, remotePath, isDir) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const done = (e) => {
        sftp.end();
        if (e) reject(e);
        else resolve(true);
      };
      if (isDir) sftp.rmdir(remotePath, done);
      else sftp.unlink(remotePath, done);
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
