import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function dataDir() {
  const override = process.env.CURSOR_SSH_MCP_HOME;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".cursor", "ssh-mcp");
}

export function hostsPath() {
  return path.join(dataDir(), "hosts.json");
}

function ensureDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
  try {
    fs.chmodSync(dataDir(), 0o700);
  } catch {
    /* windows may ignore */
  }
}

function emptyStore() {
  return { version: 1, hosts: {} };
}

export function loadHosts() {
  ensureDir();
  const file = hostsPath();
  if (!fs.existsSync(file)) {
    const store = emptyStore();
    fs.writeFileSync(file, JSON.stringify(store, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    return store;
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.hosts || typeof parsed.hosts !== "object") {
    throw new Error(`Invalid hosts file: ${file}`);
  }
  return parsed;
}

export function saveHosts(store) {
  ensureDir();
  const tmp = `${hostsPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, hostsPath());
  try {
    fs.chmodSync(hostsPath(), 0o600);
  } catch {
    /* windows */
  }
}

export function listHostsPublic(secretChecker, opts = {}) {
  const store = loadHosts();
  return Object.values(store.hosts).map((h) =>
    sanitizeHost(h, {
      hasSecretPassword: secretChecker ? Boolean(secretChecker(h.id)) : false,
      revealKeyPath: Boolean(opts.revealKeyPath),
    })
  );
}

export function getHost(id) {
  const store = loadHosts();
  const host = store.hosts[id];
  if (!host) {
    throw new Error(`Unknown host id: ${id}`);
  }
  return host;
}

export function upsertHost(input) {
  const store = loadHosts();
  const id = input.id.trim();
  if (!id) {
    throw new Error("host id is required");
  }
  if (!input.host || !String(input.host).trim()) {
    throw new Error("host address is required");
  }
  if (!input.username || !String(input.username).trim()) {
    throw new Error("username is required");
  }

  const existing = store.hosts[id] || {};
  const next = {
    id,
    name: (input.name || existing.name || id).trim(),
    host: String(input.host).trim(),
    port: Number(input.port || existing.port || 22),
    username: String(input.username).trim(),
    privateKeyPath:
      input.privateKeyPath !== undefined
        ? expandHome(input.privateKeyPath)
        : existing.privateKeyPath || "",
    passphraseEnv:
      input.passphraseEnv !== undefined
        ? String(input.passphraseEnv || "").trim()
        : existing.passphraseEnv || "",
    passwordEnv:
      input.passwordEnv !== undefined
        ? String(input.passwordEnv || "").trim()
        : existing.passwordEnv || "",
    defaultCwd:
      input.defaultCwd !== undefined
        ? String(input.defaultCwd || "").trim()
        : existing.defaultCwd || "",
    tags: Array.isArray(input.tags)
      ? input.tags.map(String)
      : existing.tags || [],
    updatedAt: new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString(),
  };

  // Password may live in secrets.json (UI) or passwordEnv — validated at connect time.
  store.hosts[id] = next;
  saveHosts(store);
  return sanitizeHost(next);
}

export function removeHost(id) {
  const store = loadHosts();
  if (!store.hosts[id]) {
    throw new Error(`Unknown host id: ${id}`);
  }
  delete store.hosts[id];
  saveHosts(store);
  return { removed: id };
}

export function expandHome(p) {
  if (!p) return "";
  const s = String(p).trim();
  if (!s) return "";
  if (s.startsWith("~/")) {
    return path.join(os.homedir(), s.slice(2));
  }
  if (s === "~") {
    return os.homedir();
  }
  return path.resolve(s);
}

export function sanitizeHost(host, opts = {}) {
  const hasSecretPassword = Boolean(opts.hasSecretPassword);
  const revealKeyPath = Boolean(opts.revealKeyPath);
  const rawKey = host.privateKeyPath || "";
  return {
    id: host.id,
    name: host.name,
    host: host.host,
    port: host.port,
    username: host.username,
    auth: host.privateKeyPath
      ? "private_key"
      : host.passwordEnv || hasSecretPassword
        ? "password"
        : "unknown",
    // MCP/未授权列表只给脱敏路径；已鉴权 UI 可 reveal 以便编辑
    privateKeyPath: rawKey
      ? revealKeyPath
        ? rawKey
        : maskPath(rawKey)
      : "",
    hasPrivateKey: Boolean(rawKey),
    passwordEnv: host.passwordEnv || "",
    passphraseEnv: host.passphraseEnv || "",
    hasPasswordSecret: hasSecretPassword,
    defaultCwd: host.defaultCwd || "",
    tags: host.tags || [],
    updatedAt: host.updatedAt,
    createdAt: host.createdAt,
  };
}

/** 脱敏本机路径，避免完整 ~/.ssh 布局泄露 */
export function maskPath(p) {
  if (!p) return "";
  let s = String(p).trim();
  if (!s) return "";
  const home = os.homedir();
  if (s === home) return "~";
  if (s.startsWith(home + path.sep) || s.startsWith(home + "/")) {
    s = `~${s.slice(home.length)}`;
  }
  const parts = s.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return s;
  return `${parts[0]}/…/${parts[parts.length - 1]}`;
}

export function resolveAuth(host, secret = {}) {
  const config = {
    host: host.host,
    port: host.port || 22,
    username: host.username,
    readyTimeout: 60000,
    // 大文件传输期间保活，避免中间设备掐断空闲连接
    keepaliveInterval: 15000,
    keepaliveCountMax: 8,
  };

  if (host.privateKeyPath) {
    const keyPath = expandHome(host.privateKeyPath);
    if (!fs.existsSync(keyPath)) {
      throw new Error(`Private key not found: ${keyPath}`);
    }
    config.privateKey = fs.readFileSync(keyPath);
    if (secret.passphrase) {
      config.passphrase = secret.passphrase;
    } else if (host.passphraseEnv) {
      const passphrase = process.env[host.passphraseEnv];
      if (!passphrase) {
        throw new Error(
          `Passphrase env ${host.passphraseEnv} is empty or unset`
        );
      }
      config.passphrase = passphrase;
    }
  }

  if (secret.password) {
    config.password = secret.password;
  } else if (host.passwordEnv) {
    const password = process.env[host.passwordEnv];
    if (!password) {
      throw new Error(`Password env ${host.passwordEnv} is empty or unset`);
    }
    config.password = password;
  }

  if (!config.privateKey && !config.password) {
    throw new Error("No usable auth material for this host");
  }

  return config;
}

export { dataDir };
