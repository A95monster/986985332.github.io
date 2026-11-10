import { Client } from "ssh2";
import { resolveAuth } from "./hosts.js";
import { getHostSecret } from "./secrets.js";

const sessions = new Map();

function connect(hostRecord) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const auth = resolveAuth(hostRecord, getHostSecret(hostRecord.id));
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH connect timeout to ${hostRecord.host}:${hostRecord.port || 22}`));
    }, auth.readyTimeout || 20000);

    conn
      .on("ready", () => {
        clearTimeout(timer);
        resolve(conn);
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .connect(auth);
  });
}

export async function withConnection(hostRecord, keepAlive, fn) {
  const key = hostRecord.id;
  let conn = sessions.get(key);
  let created = false;

  if (!conn) {
    conn = await connect(hostRecord);
    created = true;
    if (keepAlive) {
      sessions.set(key, conn);
      conn.on("close", () => {
        if (sessions.get(key) === conn) sessions.delete(key);
      });
      conn.on("end", () => {
        if (sessions.get(key) === conn) sessions.delete(key);
      });
    }
  }

  try {
    return await fn(conn);
  } catch (err) {
    // Drop broken sessions
    try {
      conn.end();
    } catch {
      /* ignore */
    }
    if (sessions.get(key) === conn) sessions.delete(key);
    throw err;
  } finally {
    if (created && !keepAlive) {
      try {
        conn.end();
      } catch {
        /* ignore */
      }
    }
  }
}

export function closeSession(hostId) {
  const conn = sessions.get(hostId);
  if (!conn) {
    return { closed: false, reason: "no active session" };
  }
  try {
    conn.end();
  } catch {
    /* ignore */
  }
  sessions.delete(hostId);
  return { closed: true, hostId };
}

export function listSessions() {
  return [...sessions.keys()];
}

export function runCommand(conn, command, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const wrapped =
      cwd && String(cwd).trim()
        ? `cd ${shellQuote(cwd)} && ${command}`
        : command;

    conn.exec(wrapped, { pty: false }, (err, stream) => {
      if (err) return reject(err);

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          stream.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      stream
        .on("close", (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            stdout,
            stderr,
            exitCode: typeof code === "number" ? code : null,
            signal: signal || null,
          });
        })
        .on("data", (data) => {
          stdout += data.toString("utf8");
        });

      stream.stderr.on("data", (data) => {
        stderr += data.toString("utf8");
      });
    });
  });
}

export function sftpRead(conn, remotePath, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.stat(remotePath, (statErr, stats) => {
        if (statErr) {
          sftp.end();
          return reject(statErr);
        }
        if (stats.isDirectory()) {
          sftp.end();
          return reject(new Error("Path is a directory; use a file path"));
        }
        if (stats.size > maxBytes) {
          sftp.end();
          return reject(
            new Error(
              `File too large (${stats.size} bytes). maxBytes=${maxBytes}`
            )
          );
        }
        const chunks = [];
        let total = 0;
        const stream = sftp.createReadStream(remotePath);
        stream.on("data", (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            stream.destroy(new Error(`Read exceeded maxBytes=${maxBytes}`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", (e) => {
          sftp.end();
          reject(e);
        });
        stream.on("end", () => {
          const buf = Buffer.concat(chunks);
          sftp.end();
          resolve({
            path: remotePath,
            size: buf.length,
            encoding: "utf8",
            content: buf.toString("utf8"),
          });
        });
      });
    });
  });
}

export function sftpWrite(conn, remotePath, content, { createDirs = false } = {}) {
  return new Promise((resolve, reject) => {
    conn.sftp(async (err, sftp) => {
      if (err) return reject(err);

      const write = () => {
        const stream = sftp.createWriteStream(remotePath);
        stream.on("error", (e) => {
          sftp.end();
          reject(e);
        });
        stream.on("close", () => {
          sftp.end();
          resolve({
            path: remotePath,
            bytesWritten: Buffer.byteLength(content, "utf8"),
          });
        });
        stream.end(content, "utf8");
      };

      if (!createDirs) {
        write();
        return;
      }

      // Best-effort mkdir -p for parent
      const parent = remotePath.replace(/\/[^/]+\/?$/, "");
      if (!parent || parent === remotePath) {
        write();
        return;
      }
      mkdirp(sftp, parent, (mkdirErr) => {
        if (mkdirErr) {
          sftp.end();
          return reject(mkdirErr);
        }
        write();
      });
    });
  });
}

function mkdirp(sftp, dir, cb) {
  const parts = dir.split("/").filter(Boolean);
  let cur = dir.startsWith("/") ? "/" : "";

  const next = (i) => {
    if (i >= parts.length) return cb(null);
    cur = cur === "/" ? `/${parts[i]}` : cur ? `${cur}/${parts[i]}` : parts[i];
    sftp.mkdir(cur, (err) => {
      if (err && err.code !== 4 && err.code !== 11) {
        // 4/11 often mean exists depending on server; ignore exists-like failures
        sftp.stat(cur, (statErr, stats) => {
          if (statErr || !stats.isDirectory()) return cb(err);
          next(i + 1);
        });
        return;
      }
      next(i + 1);
    });
  };

  next(0);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}
