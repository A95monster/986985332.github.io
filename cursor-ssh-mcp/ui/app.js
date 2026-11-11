/* global Terminal, FitAddon */
function resolvePanel() {
  const pathName = (location.pathname || "/").replace(/\/+$/, "") || "/";
  if (pathName === "/hosts") return "hosts";
  if (pathName === "/work") return "work";
  const q = new URLSearchParams(location.search).get("panel");
  if (q === "hosts" || q === "work" || q === "all") return q;
  return "all";
}

const PANEL = resolvePanel();
const BUS_NAME = "cursor-ssh-mcp-bus";
const STORE_KEY = "cursor-ssh-mcp-active";
const bus = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(BUS_NAME) : null;

const TERM_PREFS_KEY = "cursor-ssh-mcp-term-prefs";
const FONT_PRESETS = [
  { id: "mono", label: "系统等宽", value: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" },
  { id: "ibm", label: "IBM Plex Mono", value: "\"IBM Plex Mono\", ui-monospace, Menlo, monospace" },
  { id: "jetbrains", label: "JetBrains Mono", value: "\"JetBrains Mono\", Menlo, Monaco, monospace" },
  { id: "fira", label: "Fira Code", value: "\"Fira Code\", Menlo, Monaco, monospace" },
  { id: "cascadia", label: "Cascadia Code", value: "\"Cascadia Code\", Consolas, monospace" },
  { id: "source", label: "Source Code Pro", value: "\"Source Code Pro\", Menlo, monospace" },
];

function loadTermPrefs() {
  const fallback = {
    fontFamily: FONT_PRESETS[0].value,
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
  };
  try {
    const raw = localStorage.getItem(TERM_PREFS_KEY);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

const state = {
  panel: PANEL,
  hosts: [],
  activeId: null,
  localPath: "/",
  /** 左右文件面板来源：本地或某台主机 */
  endpoints: {
    left: { kind: "local", hostId: null },
    right: { kind: "host", hostId: null },
  },
  paneSelected: { left: [], right: [] },
  paneEntries: { left: [], right: [] },
  paneFilter: { left: "", right: "" },
  paneSort: {
    left: { key: "name", dir: "asc" },
    right: { key: "name", dir: "asc" },
  },
  colWidths: loadColWidths(),
  showHidden: localStorage.getItem("cursor-ssh-mcp-show-hidden") === "1",
  ctx: { side: null, entry: null },
  ctxOpenedAt: 0,
  colResize: null,
  /** @type {Record<string, Session>} */
  sessions: {},
  layout: {
    sftp: true,
    term: true,
    termHeight: null,
  },
  themeId: localStorage.getItem("cursor-ssh-mcp-theme") || "forest",
  history: [],
  utilTab: "theme",
  utilCollapsed: localStorage.getItem("cursor-ssh-mcp-util-collapsed") === "1",
  utilQuery: "",
  inputBuffer: "",
  dictOpenCats: new Set(),
  dictOnlineTimer: null,
  dictOnlineTopic: "",
  transferBusy: false,
  termPrefs: loadTermPrefs(),
};

function saveTermPrefs() {
  localStorage.setItem(TERM_PREFS_KEY, JSON.stringify(state.termPrefs));
}

const THEMES = [
  {
    id: "forest",
    name: "森绿",
    theme: {
      background: "#10211e",
      foreground: "#d7ebe6",
      cursor: "#5eead4",
      selectionBackground: "#134e4a",
      black: "#0b1a17",
      red: "#f87171",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#67e8f9",
      magenta: "#a7f3d0",
      cyan: "#2dd4bf",
      white: "#e7f5f1",
    },
  },
  {
    id: "termius",
    name: "深蓝 Termius",
    theme: {
      background: "#0b1220",
      foreground: "#d7e3f4",
      cursor: "#7dd3fc",
      selectionBackground: "#1e3a5f",
      black: "#020617",
      red: "#fb7185",
      green: "#4ade80",
      yellow: "#facc15",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#e2e8f0",
    },
  },
  {
    id: "midnight",
    name: "午夜蓝",
    theme: {
      background: "#0f172a",
      foreground: "#e2e8f0",
      cursor: "#38bdf8",
      selectionBackground: "#1e293b",
      black: "#020617",
      red: "#f87171",
      green: "#86efac",
      yellow: "#fde047",
      blue: "#93c5fd",
      magenta: "#d8b4fe",
      cyan: "#67e8f9",
      white: "#f8fafc",
    },
  },
  {
    id: "graphite",
    name: "石墨灰",
    theme: {
      background: "#1c1c1c",
      foreground: "#e5e5e5",
      cursor: "#a3a3a3",
      selectionBackground: "#404040",
      black: "#0a0a0a",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#eab308",
      blue: "#3b82f6",
      magenta: "#a855f7",
      cyan: "#06b6d4",
      white: "#fafafa",
    },
  },
  {
    id: "solar-dark",
    name: "Solar 暗色",
    theme: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      selectionBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
    },
  },
  {
    id: "mono-light",
    name: "浅色阅读",
    theme: {
      background: "#f8fafc",
      foreground: "#0f172a",
      cursor: "#0f766e",
      selectionBackground: "#ccfbf1",
      black: "#0f172a",
      red: "#b91c1c",
      green: "#047857",
      yellow: "#a16207",
      blue: "#1d4ed8",
      magenta: "#7e22ce",
      cyan: "#0e7490",
      white: "#334155",
    },
  },
  {
    id: "amber",
    name: "琥珀终端",
    theme: {
      background: "#1a1208",
      foreground: "#ffd59a",
      cursor: "#fbbf24",
      selectionBackground: "#3b2a14",
      black: "#120c06",
      red: "#f87171",
      green: "#86efac",
      yellow: "#fbbf24",
      blue: "#93c5fd",
      magenta: "#f0abfc",
      cyan: "#5eead4",
      white: "#fff7ed",
    },
  },
  {
    id: "nord",
    name: "Nord",
    theme: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#88c0d0",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    theme: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#fe8019",
      selectionBackground: "#3c3836",
      black: "#1d2021",
      red: "#fb4934",
      green: "#b8bb26",
      yellow: "#fabd2f",
      blue: "#83a598",
      magenta: "#d3869b",
      cyan: "#8ec07c",
      white: "#fbf1c7",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    theme: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#61afef",
      selectionBackground: "#3e4451",
      black: "#1e2127",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    theme: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#7aa2f7",
      selectionBackground: "#283457",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#c0caf5",
    },
  },
  {
    id: "catppuccin",
    name: "Catppuccin Mocha",
    theme: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#45475a",
      black: "#11111b",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#cba6f7",
      cyan: "#94e2d5",
      white: "#cdd6f4",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    theme: {
      background: "#272822",
      foreground: "#f8f8f2",
      cursor: "#f8f8f0",
      selectionBackground: "#49483e",
      black: "#1e1f1c",
      red: "#f92672",
      green: "#a6e22e",
      yellow: "#f4bf75",
      blue: "#66d9ef",
      magenta: "#ae81ff",
      cyan: "#a1efe4",
      white: "#f8f8f2",
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    theme: {
      background: "#0d1117",
      foreground: "#c9d1d9",
      cursor: "#58a6ff",
      selectionBackground: "#1f6feb",
      black: "#010409",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#c9d1d9",
    },
  },
  {
    id: "sea-foam",
    name: "海沫青",
    theme: {
      background: "#0b1f24",
      foreground: "#d1faf0",
      cursor: "#2dd4bf",
      selectionBackground: "#134e4a",
      black: "#042f2e",
      red: "#fb7185",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#38bdf8",
      magenta: "#e879f9",
      cyan: "#2dd4bf",
      white: "#ecfeff",
    },
  },
  {
    id: "rose-pine",
    name: "Rose Pine",
    theme: {
      background: "#191724",
      foreground: "#e0def4",
      cursor: "#c4a7e7",
      selectionBackground: "#26233a",
      black: "#16141f",
      red: "#eb6f92",
      green: "#9ccfd8",
      yellow: "#f6c177",
      blue: "#31748f",
      magenta: "#c4a7e7",
      cyan: "#ebbcba",
      white: "#e0def4",
    },
  },
  {
    id: "paper",
    name: "纸白高对比",
    theme: {
      background: "#ffffff",
      foreground: "#111827",
      cursor: "#0f766e",
      selectionBackground: "#dbeafe",
      black: "#111827",
      red: "#dc2626",
      green: "#059669",
      yellow: "#d97706",
      blue: "#2563eb",
      magenta: "#7c3aed",
      cyan: "#0891b2",
      white: "#374151",
    },
  },
  {
    id: "matrix",
    name: "Matrix 绿幕",
    theme: {
      background: "#000000",
      foreground: "#00ff66",
      cursor: "#33ff99",
      selectionBackground: "#003311",
      black: "#001a00",
      red: "#ff3333",
      green: "#00ff66",
      yellow: "#ccff33",
      blue: "#33ffcc",
      magenta: "#66ff99",
      cyan: "#00ffcc",
      white: "#ccffcc",
    },
  },
  {
    id: "cobalt",
    name: "Cobalt",
    theme: {
      background: "#002240",
      foreground: "#ffffff",
      cursor: "#ffc600",
      selectionBackground: "#0050a4",
      black: "#000d1a",
      red: "#ff628c",
      green: "#3ad900",
      yellow: "#ffc600",
      blue: "#0088ff",
      magenta: "#fb94ff",
      cyan: "#80fcff",
      white: "#ffffff",
    },
  },
  {
    id: "ayu-dark",
    name: "Ayu Dark",
    theme: {
      background: "#0b0e14",
      foreground: "#bfbdb6",
      cursor: "#e6b450",
      selectionBackground: "#1c212b",
      black: "#02060d",
      red: "#f07178",
      green: "#aad94c",
      yellow: "#ffb454",
      blue: "#59c2ff",
      magenta: "#d2a6ff",
      cyan: "#95e6cb",
      white: "#bfbdb6",
    },
  },
  {
    id: "night-owl",
    name: "Night Owl",
    theme: {
      background: "#011627",
      foreground: "#d6deeb",
      cursor: "#80a4c2",
      selectionBackground: "#1d3b53",
      black: "#011627",
      red: "#ef5350",
      green: "#22da6e",
      yellow: "#c5e478",
      blue: "#82aaff",
      magenta: "#c792ea",
      cyan: "#21c7a8",
      white: "#ffffff",
    },
  },
  {
    id: "solarized-light",
    name: "Solar 浅色",
    theme: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#586e75",
      selectionBackground: "#eee8d5",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#002b36",
    },
  },
  {
    id: "ubuntu",
    name: "Ubuntu 终端",
    theme: {
      background: "#300a24",
      foreground: "#eeeeee",
      cursor: "#eeeeee",
      selectionBackground: "#4e2a3e",
      black: "#2e3436",
      red: "#cc0000",
      green: "#4e9a06",
      yellow: "#c4a000",
      blue: "#3465a4",
      magenta: "#75507b",
      cyan: "#06989a",
      white: "#d3d7cf",
    },
  },
  {
    id: "powershell",
    name: "PowerShell 蓝",
    theme: {
      background: "#012456",
      foreground: "#f6f6f6",
      cursor: "#f6f6f6",
      selectionBackground: "#0e4b8e",
      black: "#0c0c0c",
      red: "#c50f1f",
      green: "#13a10e",
      yellow: "#c19c00",
      blue: "#0037da",
      magenta: "#881798",
      cyan: "#3a96dd",
      white: "#cccccc",
    },
  },
];

const HISTORY_KEY = "cursor-ssh-mcp-history";

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    state.history = raw ? JSON.parse(raw) : [];
  } catch {
    state.history = [];
  }
}

function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, 200)));
}

function pushHistory(cmd) {
  const text = String(cmd || "").trim();
  if (!text) return;
  state.history = [text, ...state.history.filter((x) => x !== text)].slice(0, 200);
  saveHistory();
  if (state.utilTab === "history") renderUtilHistory();
}

function currentTheme() {
  return THEMES.find((t) => t.id === state.themeId) || THEMES[0];
}

function mixHex(a, b, t) {
  const parse = (hex) => {
    const h = String(hex || "").replace("#", "").trim();
    if (h.length === 3) {
      return [h[0] + h[0], h[1] + h[1], h[2] + h[2]].map((x) => parseInt(x, 16));
    }
    if (h.length !== 6) return null;
    return [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map((x) => parseInt(x, 16));
  };
  const A = parse(a);
  const B = parse(b);
  if (!A || !B) return a || b;
  const mix = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function applyUtilRailTheme(theme) {
  const rail = $("util-rail");
  if (!rail) return;
  const bg = theme.background || "#141b22";
  const fg = theme.foreground || "#c8d0d8";
  const accent = theme.cyan || theme.green || theme.cursor || "#2dd4bf";
  const cursor = theme.cursor || accent;
  const soft = mixHex(bg, fg, 0.12);
  const line = mixHex(bg, fg, 0.22);
  const muted = mixHex(fg, bg, 0.35);
  rail.style.setProperty("--util-bg", bg);
  rail.style.setProperty("--util-bg-soft", soft);
  rail.style.setProperty("--util-fg", fg);
  rail.style.setProperty("--util-muted", muted);
  rail.style.setProperty("--util-line", line);
  rail.style.setProperty("--util-accent", accent);
  rail.style.setProperty("--util-cursor", cursor);
  rail.style.background = bg;
  rail.style.color = fg;
  rail.style.borderColor = line;
}

function applyThemeToAll() {
  const theme = currentTheme().theme;
  const prefs = state.termPrefs || loadTermPrefs();
  Object.values(state.sessions).forEach((sess) => {
    if (sess.term) {
      sess.term.options.theme = theme;
      sess.term.options.fontFamily = prefs.fontFamily;
      sess.term.options.fontSize = Number(prefs.fontSize) || 13;
      sess.term.options.lineHeight = Number(prefs.lineHeight) || 1.2;
      sess.term.options.cursorBlink = Boolean(prefs.cursorBlink);
      try {
        sess.fit?.fit();
      } catch {
        /* ignore */
      }
    }
  });
  const termPane = $("term-pane");
  if (termPane) {
    termPane.style.background = theme.background || "#10211e";
    termPane.style.color = theme.foreground || "#d7ebe6";
  }
  const stack = $("terminal-stack");
  if (stack) {
    stack.style.fontFamily = prefs.fontFamily;
  }
  applyUtilRailTheme(theme);
}

document.body.dataset.panel = state.panel;

function publish(msg) {
  const payload = { ...msg, at: Date.now() };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
  if (bus) bus.postMessage(payload);
}

function readStoredSelection() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} Session
 * @property {'idle'|'connecting'|'online'|'error'} status
 * @property {string} [error]
 * @property {string} remotePath
 * @property {any} [remoteSelected]
 * @property {any} [term]
 * @property {any} [fit]
 * @property {WebSocket|null} [ws]
 * @property {HTMLElement|null} [mount]
 * @property {boolean} [sftpReady]
 */

function uiOrigin() {
  // Cursor 工作台 iframe 通常就是 127.0.0.1:port；异常 origin 时回落到本机 UI
  try {
    if (/^https?:$/i.test(location.protocol) && location.host) {
      return location.origin;
    }
  } catch {
    /* ignore */
  }
  return "http://127.0.0.1:3847";
}

function api(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${uiOrigin()}${path}`;
  return fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
      return data;
    })
    .catch((err) => {
      const msg = String(err && err.message ? err.message : err);
      if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
        throw new Error(
          "连不上本机 SSH UI 服务（127.0.0.1:3847）。请在 Cursor 命令面板执行「SSH: Restart UI Server」或重新打开 SSH 工作台。"
        );
      }
      throw err;
    });
}

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function hostInitial(host) {
  const raw = String(host.name || host.id || "?").trim();
  return raw.slice(0, 1).toUpperCase() || "?";
}

function ensureSession(id) {
  if (!state.sessions[id]) {
    const host = state.hosts.find((h) => h.id === id);
    state.sessions[id] = {
      status: "idle",
      remotePath: host?.defaultCwd || ".",
      remoteSelected: null,
      term: null,
      fit: null,
      ws: null,
      mount: null,
      sftpReady: false,
    };
  }
  return state.sessions[id];
}

function statusLabel(status) {
  switch (status) {
    case "connecting":
      return "连接中";
    case "online":
      return "已连接";
    case "error":
      return "失败";
    default:
      return "未连接";
  }
}

function updateEmptyState() {
  const empty = $("host-empty");
  const list = $("host-list");
  const hasHosts = state.hosts.length > 0;
  empty.classList.toggle("hidden", hasHosts);
  list.classList.toggle("hidden", !hasHosts);
}

function updateLayoutChrome() {
  const sftpPane = $("sftp-pane");
  const termPane = $("term-pane");
  const resize = $("panel-resize");
  const showTerm = $("btn-show-term");
  const showSftp = $("btn-show-sftp");
  const closeSftp = $("btn-close-sftp");
  const closeTerm = $("btn-close-term");
  const bothOpen = state.layout.sftp && state.layout.term;

  sftpPane.classList.toggle("hidden", !state.layout.sftp);
  termPane.classList.toggle("hidden", !state.layout.term);
  resize.classList.toggle("hidden", !bothOpen);
  showTerm.classList.toggle("hidden", state.layout.term);
  showSftp.classList.toggle("hidden", state.layout.sftp);
  // 只剩一个窗口时隐藏关闭按钮（关了也没用）
  closeSftp?.classList.toggle("hidden", !bothOpen);
  closeTerm?.classList.toggle("hidden", !bothOpen);

  if (state.layout.sftp && state.layout.term) {
    termPane.style.flex = "none";
    termPane.style.height = state.layout.termHeight
      ? `${state.layout.termHeight}px`
      : "36%";
    sftpPane.style.flex = "1";
  } else if (state.layout.term) {
    termPane.style.flex = "1";
    termPane.style.height = "auto";
    sftpPane.style.flex = "0";
  } else if (state.layout.sftp) {
    sftpPane.style.flex = "1";
    termPane.style.flex = "0";
  }

  const sess = state.activeId ? ensureSession(state.activeId) : null;
  fitActiveTerminal();
  if (sess) updateTermStatus(sess);
}

function updateActiveLabels() {
  const sftpLabel = $("sftp-host-label");
  const termTitle = $("term-title");
  const L = endpointLabel(state.endpoints.left);
  const R = endpointLabel(state.endpoints.right);
  if (sftpLabel) sftpLabel.textContent = `${L} → ${R}`;
  const host = state.hosts.find((h) => h.id === state.activeId);
  if (!host) {
    if (termTitle) termTitle.textContent = "终端";
    return;
  }
  if (termTitle) termTitle.textContent = `终端 · ${host.name || host.id}`;
}

function updateTermStatus(sess) {
  const el = $("term-status");
  el.textContent = statusLabel(sess.status);
  el.className = `status-pill ${sess.status}`;
}

function renderHosts() {
  const ul = $("host-list");
  ul.innerHTML = "";
  state.hosts.forEach((h) => {
    const sess = ensureSession(h.id);
    const li = document.createElement("li");
    li.dataset.id = h.id;
    if (h.id === state.activeId) li.classList.add("active");
    li.innerHTML = `
      <div class="host-card-main">
        <div class="host-avatar" aria-hidden="true">${escapeHtml(hostInitial(h))}</div>
        <div class="host-copy">
          <div class="host-name-row">
            <div class="host-name">${escapeHtml(h.name || h.id)}</div>
            <span class="status-pill ${sess.status}">${statusLabel(sess.status)}</span>
          </div>
          <div class="host-meta">${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port || 22}</div>
        </div>
      </div>
      <div class="host-actions">
        <button type="button" class="btn btn-secondary btn-compact" data-act="sftp">文件</button>
        <button type="button" class="btn btn-primary btn-compact" data-act="term">终端</button>
        <button type="button" class="btn btn-ghost btn-compact" data-act="both">默认</button>
        <button type="button" class="btn btn-ghost btn-compact" data-act="edit">编辑</button>
        <button type="button" class="btn btn-danger btn-compact" data-act="delete">删除</button>
        ${
          sess.status === "online" || sess.status === "connecting"
            ? `<button type="button" class="btn btn-ghost btn-compact" data-act="disconnect">断开</button>`
            : ""
        }
      </div>
    `;
    li.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      selectHost(h.id, "both");
    });
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openHostDialog(h);
    });
    li.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const act = btn.getAttribute("data-act");
        if (act === "disconnect") {
          disconnectHost(h.id);
          return;
        }
        if (act === "edit") {
          openHostDialog(h);
          return;
        }
        if (act === "delete") {
          deleteHost(h.id, h.name || h.id);
          return;
        }
        selectHost(h.id, act);
      });
    });
    ul.appendChild(li);
  });
  updateEmptyState();
  updateActiveLabels();
}

async function deleteHost(id, label) {
  if (!confirm(`确定删除主机「${label}」吗？此操作不可恢复。`)) return;
  disconnectHost(id);
  await api(`/api/hosts/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (state.activeId === id) {
    state.activeId = null;
    updateTermStatus({ status: "idle" });
  }
  ["left", "right"].forEach((side) => {
    const ep = state.endpoints[side];
    if (ep.kind === "host" && ep.hostId === id) {
      state.endpoints[side] = side === "left" ? { kind: "local", hostId: null } : { kind: "host", hostId: null };
      state.paneSelected[side] = [];
    }
  });
  renderSourceMenus();
  refreshPane("left");
  refreshPane("right");
  updateActiveLabels();
  if (state.sessions[id]?.mount) {
    state.sessions[id].mount.remove();
  }
  delete state.sessions[id];
  await refreshHosts();
  publish({ type: "hostsChanged" });
}

async function refreshHosts() {
  const data = await api("/api/hosts");
  state.hosts = data.hosts || [];
  if (!state.localPath || state.localPath === "/") {
    state.localPath = data.home || "/";
    $("local-path").value = state.localPath;
  }
  state.hosts.forEach((h) => ensureSession(h.id));
  if (
    state.endpoints.right.kind === "host" &&
    state.endpoints.right.hostId &&
    !state.hosts.some((h) => h.id === state.endpoints.right.hostId)
  ) {
    state.endpoints.right.hostId = null;
  }
  renderHosts();
  renderSourceMenus();
}

function showTerminalMount(id) {
  const stack = $("terminal-stack");
  const placeholder = $("term-placeholder");
  Object.values(state.sessions).forEach((s) => {
    if (s.mount) s.mount.classList.add("hidden");
  });
  const sess = ensureSession(id);
  if (!sess.mount) {
    const mount = document.createElement("div");
    mount.className = "term-mount";
    mount.dataset.hostId = id;
    stack.appendChild(mount);
    sess.mount = mount;
  }
  sess.mount.classList.remove("hidden");
  placeholder.classList.toggle("hidden", Boolean(sess.term));
}

function ensureTerminalFor(id) {
  const sess = ensureSession(id);
  if (sess.term) {
    showTerminalMount(id);
    fitActiveTerminal();
    return true;
  }
  if (typeof Terminal === "undefined" || typeof FitAddon === "undefined") {
    console.warn("终端组件尚未加载完成");
    return false;
  }
  showTerminalMount(id);
  const prefs = state.termPrefs || loadTermPrefs();
  sess.term = new Terminal({
    cursorBlink: Boolean(prefs.cursorBlink),
    fontSize: Number(prefs.fontSize) || 13,
    lineHeight: Number(prefs.lineHeight) || 1.2,
    fontFamily: prefs.fontFamily,
    theme: currentTheme().theme,
  });
  sess.fit = new FitAddon.FitAddon();
  sess.term.loadAddon(sess.fit);
  sess.term.open(sess.mount);
  $("term-placeholder").classList.add("hidden");
  applyThemeToAll();
  fitActiveTerminal();
  return true;
}

function fitActiveTerminal() {
  const sess = state.activeId ? state.sessions[state.activeId] : null;
  if (sess?.fit && state.layout.term) {
    requestAnimationFrame(() => {
      try {
        sess.fit.fit();
        if (sess.ws && sess.ws.readyState === WebSocket.OPEN && sess.term) {
          sess.ws.send(
            JSON.stringify({
              type: "resize",
              cols: sess.term.cols,
              rows: sess.term.rows,
            })
          );
        }
      } catch {
        /* ignore */
      }
    });
  }
}

function connectTerminal(id) {
  if (!ensureTerminalFor(id)) {
    alert("终端组件加载失败，请刷新页面");
    return;
  }
  const sess = ensureSession(id);
  if (sess.ws && (sess.ws.readyState === WebSocket.OPEN || sess.ws.readyState === WebSocket.CONNECTING)) {
    updateTermStatus(sess);
    renderHosts();
    return;
  }

  sess.status = "connecting";
  sess.error = "";
  updateTermStatus(sess);
  renderHosts();

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/shell?id=${encodeURIComponent(id)}`);
  sess.ws = ws;

  ws.onopen = () => {
    /* ready comes from server after shell starts */
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "data") sess.term.write(msg.data);
    if (msg.type === "error") {
      sess.status = "error";
      sess.error = msg.message;
      sess.term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
      updateTermStatus(sess);
      renderHosts();
    }
    if (msg.type === "ready") {
      sess.status = "online";
      updateTermStatus(sess);
      renderHosts();
      fitActiveTerminal();
    }
  };
  ws.onclose = () => {
    if (sess.ws === ws) {
      sess.ws = null;
      if (sess.status !== "error") sess.status = "idle";
      updateTermStatus(sess);
      renderHosts();
    }
  };
  ws.onerror = () => {
    sess.status = "error";
    sess.error = "连接失败";
    updateTermStatus(sess);
    renderHosts();
  };

  sess.term.onData((data) => {
    if (data === "\r") {
      pushHistory(state.inputBuffer);
      state.inputBuffer = "";
    } else if (data === "\u007f") {
      state.inputBuffer = state.inputBuffer.slice(0, -1);
    } else if (data.length === 1 && data >= " ") {
      state.inputBuffer += data;
    }
    if (sess.ws && sess.ws.readyState === WebSocket.OPEN) {
      sess.ws.send(JSON.stringify({ type: "input", data }));
    }
  });
  sess.term.onResize(({ cols, rows }) => {
    if (sess.ws && sess.ws.readyState === WebSocket.OPEN) {
      sess.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  });
}

function disconnectHost(id) {
  const sess = ensureSession(id);
  if (sess.ws) {
    try {
      sess.ws.close();
    } catch {
      /* ignore */
    }
    sess.ws = null;
  }
  sess.status = "idle";
  sess.error = "";
  if (state.activeId === id) updateTermStatus(sess);
  renderHosts();
}

function paneDom(side) {
  return side === "left"
    ? { path: $("local-path"), list: $("local-list"), btn: $("left-source-btn"), menu: $("left-source-menu") }
    : { path: $("remote-path"), list: $("remote-list"), btn: $("right-source-btn"), menu: $("right-source-menu") };
}

function endpointLabel(ep) {
  if (!ep || ep.kind === "local") return "本地";
  const host = state.hosts.find((h) => h.id === ep.hostId);
  return host ? host.name || host.id : "主机";
}

function sameEndpoint(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "local") return true;
  return a.hostId === b.hostId;
}

function updateTransferHint() {
  const hint = $("transfer-hint");
  if (!hint) return;
  const L = endpointLabel(state.endpoints.left);
  const R = endpointLabel(state.endpoints.right);
  hint.textContent = `${L} ↔ ${R} · 拖拽到对侧传输 · 右键更多操作`;
}

function formatSize(n) {
  const num = Number(n) || 0;
  if (num <= 0) return "—";
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / 1024 / 1024).toFixed(1)} MB`;
  return `${(num / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatMtime(ms) {
  const t = Number(ms) || 0;
  if (!t) return "—";
  const d = new Date(t);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderCrumb(side, fullPath) {
  const el = $(side === "left" ? "left-crumb" : "right-crumb");
  if (!el) return;
  const raw = String(fullPath || "/");
  if (raw === "." || raw === "") {
    el.innerHTML = `<button type="button" class="crumb-item" data-side="${side}" data-path="${escapeHtml(raw || ".")}">当前目录</button>`;
    return;
  }
  const abs = raw.startsWith("/");
  const parts = raw.split("/").filter(Boolean);
  const nodes = [];
  if (abs) nodes.push({ label: "根目录", path: "/" });
  let acc = abs ? "" : "";
  parts.forEach((p, i) => {
    if (abs) acc = `${acc}/${p}`.replace(/\/+/g, "/") || "/";
    else acc = i === 0 ? p : `${acc}/${p}`;
    nodes.push({ label: p, path: acc });
  });
  if (!nodes.length) nodes.push({ label: raw, path: raw });
  el.innerHTML = nodes
    .map(
      (n, i) =>
        `<button type="button" class="crumb-item" data-side="${side}" data-path="${escapeHtml(n.path)}">${escapeHtml(n.label)}</button>${i < nodes.length - 1 ? '<span class="crumb-sep">/</span>' : ""}`
    )
    .join("");
}

function visibleEntries(side) {
  const sort = state.paneSort[side] || { key: "name", dir: "asc" };
  const q = String(state.paneFilter[side] || "")
    .trim()
    .toLowerCase();
  let list = (state.paneEntries[side] || []).slice();
  if (!state.showHidden) list = list.filter((e) => !e.hidden && !String(e.name || "").startsWith("."));
  if (q) {
    list = list.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        String(e.kind || "").toLowerCase().includes(q) ||
        String(e.perm || "").toLowerCase().includes(q)
    );
  }
  const dir = sort.dir === "desc" ? -1 : 1;
  list.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    const ka = sort.key;
    if (ka === "size") return ((a.size || 0) - (b.size || 0)) * dir;
    if (ka === "mtime") return ((a.mtime || 0) - (b.mtime || 0)) * dir;
    if (ka === "kind") return String(a.kind || "").localeCompare(String(b.kind || ""), "zh") * dir;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh") * dir;
  });
  return list;
}

function loadColWidths() {
  const def = { name: 46, mtime: 24, size: 14, kind: 16 };
  try {
    const raw = JSON.parse(localStorage.getItem("cursor-ssh-mcp-col-widths") || "null");
    if (!raw || typeof raw !== "object") return def;
    return {
      name: clampCol(raw.name, def.name),
      mtime: clampCol(raw.mtime, def.mtime),
      size: clampCol(raw.size, def.size),
      kind: clampCol(raw.kind, def.kind),
    };
  } catch {
    return def;
  }
}

function clampCol(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(8, Math.min(70, n));
}

function saveColWidths() {
  localStorage.setItem("cursor-ssh-mcp-col-widths", JSON.stringify(state.colWidths));
}

function applyColWidths(side) {
  const tables = side
    ? [document.querySelector(`.file-table[data-side="${side}"]`)].filter(Boolean)
    : [...document.querySelectorAll(".file-table")];
  const w = state.colWidths;
  tables.forEach((table) => {
    table.querySelectorAll("colgroup col").forEach((col) => {
      const key = col.getAttribute("data-col");
      if (key && w[key] != null) col.style.width = `${w[key]}%`;
    });
  });
}

function updateSortHeaders(side) {
  const table = document.querySelector(`.file-table[data-side="${side}"]`);
  if (!table) return;
  const sort = state.paneSort[side];
  table.querySelectorAll("th.sortable").forEach((th) => {
    const key = th.getAttribute("data-sort");
    th.classList.toggle("sorted", key === sort.key);
    th.dataset.dir = key === sort.key ? sort.dir : "";
    const label = th.querySelector(".th-label");
    if (!label) return;
    const base = label.textContent.replace(/\s*[↑↓]\s*$/, "").trim();
    label.innerHTML =
      key === sort.key
        ? `${escapeHtml(base)}<span class="th-sort">${sort.dir === "asc" ? "↑" : "↓"}</span>`
        : escapeHtml(base);
  });
}

function updateRightEmpty() {
  const empty = $("right-empty");
  const wrap = $("remote-pane")?.querySelector(".file-table-wrap");
  const nav = $("remote-pane")?.querySelector(".file-nav");
  const ep = state.endpoints.right;
  const need = ep.kind === "host" && !ep.hostId;
  empty?.classList.toggle("hidden", !need);
  wrap?.classList.toggle("hidden", Boolean(need));
  nav?.classList.toggle("hidden", Boolean(need));
}

function renderSourceMenus() {
  ["left", "right"].forEach((side) => {
    const { btn, menu } = paneDom(side);
    if (!btn || !menu) return;
    const ep = state.endpoints[side];
    btn.textContent = endpointLabel(ep);
    btn.dataset.kind = ep.kind;
    let html = `<button type="button" class="source-option ${ep.kind === "local" ? "active" : ""}" data-kind="local">本地</button>`;
    state.hosts.forEach((h) => {
      const active = ep.kind === "host" && ep.hostId === h.id;
      html += `<button type="button" class="source-option ${active ? "active" : ""}" data-kind="host" data-id="${escapeHtml(h.id)}">${escapeHtml(h.name || h.id)}<small>${escapeHtml(h.username)}@${escapeHtml(h.host)}</small></button>`;
    });
    if (!state.hosts.length) {
      html += `<div class="source-empty">还没有主机，先在左侧添加</div>`;
    }
    menu.innerHTML = html;
  });
  updateTransferHint();
  updateActiveLabels();
}

async function setEndpoint(side, kind, hostId) {
  const other = side === "left" ? "right" : "left";
  const next = { kind, hostId: kind === "host" ? hostId : null };
  if (kind === "host" && !hostId) {
    console.warn("setEndpoint: missing hostId");
    return;
  }
  // 左右不能相同：冲突时自动把另一侧切到本地
  if (sameEndpoint(next, state.endpoints[other])) {
    state.endpoints[other] = { kind: "local", hostId: null };
    state.paneSelected[other] = [];
  }
  state.endpoints[side] = next;
  state.paneSelected[side] = [];
  if (kind === "host") {
    ensureSession(hostId);
    state.activeId = hostId;
    updateTermStatus(ensureSession(hostId));
  }
  closeSourceMenus();
  renderSourceMenus();
  updateRightEmpty();
  await refreshPane("left");
  await refreshPane("right");
  renderHosts();
  updateActiveLabels();
}

function closeSourceMenus() {
  $("left-source-menu")?.classList.add("hidden");
  $("right-source-menu")?.classList.add("hidden");
}

function selectedEntries(side) {
  const list = state.paneSelected[side];
  return Array.isArray(list) ? list : list ? [list] : [];
}

function syncSelectionUi(tbody, side) {
  const selected = new Set(selectedEntries(side).map((e) => e.path));
  [...tbody.querySelectorAll("tr[data-path]")].forEach((tr) => {
    tr.classList.toggle("selected", selected.has(tr.getAttribute("data-path")));
  });
}

function renderFileList(side) {
  const tbody = paneDom(side).list;
  if (!tbody) return;
  const entries = visibleEntries(side);
  const selectedPaths = new Set(selectedEntries(side).map((e) => e.path));
  updateSortHeaders(side);

  const parentRow = {
    name: "..",
    path: "__parent__",
    type: "dir",
    size: 0,
    mtime: 0,
    perm: "",
    kind: "上级目录",
    isParent: true,
  };
  const rows = [parentRow, ...entries];
  tbody.innerHTML = "";
  rows.forEach((e, idx) => {
    const tr = document.createElement("tr");
    const isDir = e.type === "dir";
    tr.className = isDir ? "dir" : "file";
    if (selectedPaths.has(e.path)) tr.classList.add("selected");
    tr.setAttribute("data-path", e.path);
    tr.setAttribute("data-idx", String(idx));
    tr.draggable = !e.isParent && e.type === "file";
    const icon = e.isParent ? "↩" : isDir ? "📁" : "📄";
    tr.innerHTML = `
      <td class="col-name">
        <span class="name-cell">
          <span class="file-ico">${icon}</span>
          <span class="file-meta">
            <span class="file-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span>
            ${e.perm ? `<span class="file-perm">${escapeHtml(e.perm)}</span>` : ""}
          </span>
        </span>
      </td>
      <td class="col-mtime">${e.isParent ? "" : escapeHtml(formatMtime(e.mtime))}</td>
      <td class="col-size">${e.isParent || isDir ? "" : escapeHtml(formatSize(e.size))}</td>
      <td class="col-kind">${escapeHtml(e.kind || (isDir ? "文件夹" : "文件"))}</td>`;

    tr.addEventListener("click", (ev) => {
      if (e.isParent) return;
      const cur = selectedEntries(side);
      const list = entries;
      if (ev.metaKey || ev.ctrlKey) {
        if (e.type !== "file") {
          state.paneSelected[side] = [e];
        } else {
          const exists = cur.find((x) => x.path === e.path);
          state.paneSelected[side] = exists
            ? cur.filter((x) => x.path !== e.path)
            : [...cur.filter((x) => x.type === "file"), e];
        }
      } else if (ev.shiftKey && cur.length) {
        const lastPath = cur[cur.length - 1]?.path;
        const a = list.findIndex((n) => n.path === lastPath);
        const b = list.findIndex((n) => n.path === e.path);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          state.paneSelected[side] = list.slice(lo, hi + 1).filter((x) => x.type === "file");
        } else state.paneSelected[side] = [e];
      } else {
        state.paneSelected[side] = [e];
      }
      syncSelectionUi(tbody, side);
    });

    tr.addEventListener("dblclick", async () => {
      if (e.isParent) {
        await upPane(side);
        return;
      }
      if (e.type !== "dir") return;
      const ep = state.endpoints[side];
      if (ep.kind === "local") {
        state.localPath = e.path;
        paneDom(side).path.value = e.path;
      } else if (ep.hostId) {
        ensureSession(ep.hostId).remotePath = e.path;
        paneDom(side).path.value = e.path;
      }
      state.paneSelected[side] = [];
      await refreshPane(side);
    });

    tr.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (e.isParent) {
        state.ctx = { side, entry: null };
      } else {
        if (!selectedPaths.has(e.path)) {
          state.paneSelected[side] = [e];
          syncSelectionUi(tbody, side);
        }
        state.ctx = { side, entry: e };
      }
      showContextMenu(ev.clientX, ev.clientY);
    });

    tr.addEventListener("dragstart", (ev) => {
      if (e.isParent || e.type !== "file") {
        ev.preventDefault();
        return;
      }
      let files = selectedEntries(side).filter((x) => x.type === "file");
      if (!files.find((x) => x.path === e.path)) {
        files = [e];
        state.paneSelected[side] = [e];
        syncSelectionUi(tbody, side);
      }
      ev.dataTransfer.setData(
        "application/x-ssh-mcp",
        JSON.stringify({ side, entries: files, endpoint: state.endpoints[side] })
      );
      ev.dataTransfer.effectAllowed = "copy";
    });

    tbody.appendChild(tr);
  });

  if (!entries.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" class="empty-row">${state.paneFilter[side] ? "没有匹配的文件" : "此目录为空"}</td>`;
    tbody.appendChild(tr);
  }
}

async function refreshPane(side) {
  const ep = state.endpoints[side];
  const dom = paneDom(side);
  if (!dom.list) return;
  updateRightEmpty();
  if (side === "right" && ep.kind === "host" && !ep.hostId) {
    state.paneEntries[side] = [];
    dom.list.innerHTML = "";
    return;
  }
  if (ep.kind === "local") {
    try {
      const data = await api(`/api/local/list?path=${encodeURIComponent(state.localPath || "/")}`);
      state.localPath = data.path;
      dom.path.value = data.path;
      state.paneEntries[side] = data.entries || [];
      renderCrumb(side, data.path);
      renderFileList(side);
    } catch (err) {
      dom.list.innerHTML = `<tr><td colspan="4" class="empty-row">${escapeHtml(err.message)}</td></tr>`;
    }
    return;
  }
  if (!ep.hostId) {
    dom.list.innerHTML = `<tr><td colspan="4" class="empty-row">请选择主机</td></tr>`;
    return;
  }
  const sess = ensureSession(ep.hostId);
  try {
    const data = await api(
      `/api/remote/list?id=${encodeURIComponent(ep.hostId)}&path=${encodeURIComponent(sess.remotePath || ".")}`
    );
    sess.remotePath = data.path;
    sess.sftpReady = true;
    if (sess.status === "idle") sess.status = "online";
    dom.path.value = data.path;
    state.paneEntries[side] = data.entries || [];
    renderCrumb(side, data.path);
    renderFileList(side);
    renderHosts();
  } catch (err) {
    sess.sftpReady = false;
    if (sess.status !== "online") sess.status = "error";
    sess.error = err.message;
    dom.list.innerHTML = `<tr><td colspan="4" class="empty-row">${escapeHtml(err.message)}</td></tr>`;
    renderHosts();
  }
}

async function refreshLocal() {
  if (state.endpoints.left.kind === "local") await refreshPane("left");
  if (state.endpoints.right.kind === "local") await refreshPane("right");
}

async function refreshRemote() {
  if (state.endpoints.left.kind === "host") await refreshPane("left");
  if (state.endpoints.right.kind === "host") await refreshPane("right");
}

function panePath(side) {
  const ep = state.endpoints[side];
  if (ep.kind === "local") return state.localPath;
  return ensureSession(ep.hostId).remotePath || ".";
}

function joinPath(dir, name) {
  return `${String(dir || "").replace(/\/$/, "")}/${name}`;
}

function setTransferProgress(visible, label, ratio) {
  const box = $("transfer-progress");
  const fill = $("transfer-progress-fill");
  const text = $("transfer-progress-label");
  if (!box || !fill || !text) return;
  box.classList.toggle("hidden", !visible);
  text.textContent = label || "";
  fill.style.width = `${Math.max(0, Math.min(100, Math.round((ratio || 0) * 100)))}%`;
}

function formatSpeed(bps) {
  const n = Number(bps) || 0;
  if (n < 1024) return `${n} B/s`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB/s`;
  return `${(n / 1024 / 1024).toFixed(2)} MB/s`;
}

function transferProgressLabel(ev) {
  const done = ev.completedFiles || 0;
  const total = ev.totalFiles || 0;
  const name = ev.name || "";
  const speed = ev.speedBps != null ? ` · ${formatSpeed(ev.speedBps)}` : "";
  if (ev.type === "retry") return `重试 ${name}（第 ${ev.attempt} 次）`;
  if (ev.totalBytes > 0 && ev.transferredBytes != null) {
    return `(${done}/${total}) ${name}  ${formatSize(ev.transferredBytes)}/${formatSize(ev.totalBytes)}${speed}`;
  }
  return `(${done}/${total}) ${name}${speed}`;
}

function transferRatio(ev) {
  if (ev.totalBytes > 0 && ev.transferredBytes != null) {
    return Math.min(0.999, ev.transferredBytes / ev.totalBytes);
  }
  if (ev.totalFiles > 0) return (ev.completedFiles || 0) / ev.totalFiles;
  return 0;
}

async function apiNdjson(pathName, body, onEvent) {
  const url = pathName.startsWith("http") ? pathName : `${uiOrigin()}${pathName}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
      },
      body: JSON.stringify({ ...body, stream: true }),
    });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      throw new Error(
        "连不上本机 SSH UI 服务（127.0.0.1:3847）。请在 Cursor 命令面板执行「SSH: Restart UI Server」或重新打开 SSH 工作台。"
      );
    }
    throw err;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
  }
  if (!res.body || !res.body.getReader) {
    const data = await res.json().catch(() => ({}));
    if (data.error) throw new Error(data.error);
    if (onEvent) onEvent({ type: "done", ...data });
    return data;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let final = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "error") throw new Error(ev.error || "传输失败");
      if (onEvent) onEvent(ev);
      if (ev.type === "done") final = ev;
    }
  }
  const rest = buf.trim();
  if (rest) {
    try {
      const ev = JSON.parse(rest);
      if (ev.type === "error") throw new Error(ev.error || "传输失败");
      if (onEvent) onEvent(ev);
      if (ev.type === "done") final = ev;
    } catch (err) {
      if (err.message && !/JSON/.test(err.message)) throw err;
    }
  }
  return final || { count: 0 };
}

async function transferFiles(fromSide, toSide, files) {
  const fromEp = state.endpoints[fromSide];
  const toEp = state.endpoints[toSide];
  const list = (files || selectedEntries(fromSide)).filter((x) => x && x.type === "file");
  if (!list.length) {
    alert(`请先在${fromSide === "left" ? "左侧" : "右侧"}选中文件（支持 Ctrl/⌘ 多选，或拖拽）`);
    return;
  }
  if (sameEndpoint(fromEp, toEp)) {
    alert("左右来源相同，无法传输");
    return;
  }
  if (fromEp.kind === "local" && toEp.kind === "local") {
    alert("暂不支持本地到本地传输");
    return;
  }
  if (toEp.kind === "host" && !toEp.hostId) {
    alert("请先选择目标主机");
    return;
  }
  if (fromEp.kind === "host" && !fromEp.hostId) {
    alert("请先选择源主机");
    return;
  }
  if (state.transferBusy) return;
  state.transferBusy = true;
  setTransferProgress(true, `准备传输 ${list.length} 个文件…`, 0);
  const started = Date.now();
  const onProgress = (ev) => {
    if (!ev || ev.type === "done" || ev.type === "start") {
      if (ev?.type === "start") {
        setTransferProgress(
          true,
          `开始传输 ${ev.totalFiles} 个文件${ev.totalBytes ? `（${formatSize(ev.totalBytes)}）` : ""}…`,
          0
        );
      }
      return;
    }
    setTransferProgress(true, transferProgressLabel(ev), transferRatio(ev));
  };
  try {
    if (fromEp.kind === "local" && toEp.kind === "host") {
      const payload = list.map((f) => ({
        localPath: f.path,
        remotePath: joinPath(panePath(toSide), f.name),
      }));
      await apiNdjson(
        "/api/transfer/upload-batch",
        { id: toEp.hostId, files: payload },
        onProgress
      );
    } else if (fromEp.kind === "host" && toEp.kind === "local") {
      const payload = list.map((f) => ({
        remotePath: f.path,
        localPath: joinPath(panePath(toSide), f.name),
      }));
      await apiNdjson(
        "/api/transfer/download-batch",
        { id: fromEp.hostId, files: payload },
        onProgress
      );
    } else if (fromEp.kind === "host" && toEp.kind === "host") {
      for (let i = 0; i < list.length; i++) {
        const selected = list[i];
        const toPath = joinPath(panePath(toSide), selected.name);
        setTransferProgress(true, `(${i + 1}/${list.length}) ${selected.name}`, i / list.length);
        await api("/api/transfer/relay", {
          method: "POST",
          body: JSON.stringify({
            fromId: fromEp.hostId,
            fromPath: selected.path,
            toId: toEp.hostId,
            toPath,
          }),
        });
        setTransferProgress(true, `(${i + 1}/${list.length}) 完成 ${selected.name}`, (i + 1) / list.length);
      }
    }
    const ms = Date.now() - started;
    setTransferProgress(
      true,
      `完成 ${list.length} 个文件（${Math.max(1, Math.round(ms / 1000))}s）`,
      1
    );
    await refreshPane(toSide);
    setTimeout(() => setTransferProgress(false, "", 0), 1400);
  } catch (err) {
    setTransferProgress(true, `失败：${err.message}`, 1);
    alert(err.message || String(err));
  } finally {
    state.transferBusy = false;
  }
}

function askText({ title = "输入", message = "", defaultValue = "", placeholder = "" } = {}) {
  return new Promise((resolve) => {
    const dlg = $("app-prompt");
    const form = $("app-prompt-form");
    const input = $("app-prompt-input");
    if (!dlg || !form || !input) {
      resolve(null);
      return;
    }
    $("app-prompt-title").textContent = title;
    $("app-prompt-message").textContent = message;
    input.value = defaultValue || "";
    input.placeholder = placeholder || "";
    const onClose = () => {
      dlg.removeEventListener("close", onClose);
      resolve(dlg.returnValue === "ok" ? input.value : null);
    };
    dlg.addEventListener("close", onClose);
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

function askConfirm({ title = "确认", message = "", okText = "确定" } = {}) {
  return new Promise((resolve) => {
    const dlg = $("app-confirm");
    const okBtn = $("app-confirm-ok");
    if (!dlg) {
      resolve(false);
      return;
    }
    $("app-confirm-title").textContent = title;
    $("app-confirm-message").textContent = message;
    if (okBtn) okBtn.textContent = okText;
    const onClose = () => {
      dlg.removeEventListener("close", onClose);
      resolve(dlg.returnValue === "ok");
    };
    dlg.addEventListener("close", onClose);
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
  });
}

function showContextMenu(x, y) {
  const menu = $("file-context-menu");
  if (!menu) return;
  const entry = state.ctx.entry;
  const hasEntry = Boolean(entry);
  const isFile = entry?.type === "file";
  menu.querySelectorAll("[data-ctx]").forEach((btn) => {
    const act = btn.getAttribute("data-ctx");
    let enabled = true;
    if (act === "rename" || act === "chmod") enabled = hasEntry;
    if (act === "delete") enabled = hasEntry || selectedEntries(state.ctx.side || "left").length > 0;
    if (act === "copy") enabled = isFile || selectedEntries(state.ctx.side || "left").some((e) => e.type === "file");
    btn.disabled = !enabled;
  });
  menu.classList.remove("hidden");
  state.ctxOpenedAt = Date.now();
  // 先显示再量尺寸，避免 display:none 时宽高为 0
  const pad = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - Math.max(rect.width, 160) - pad);
  const top = Math.min(y, window.innerHeight - Math.max(rect.height, 120) - pad);
  menu.style.left = `${Math.max(pad, left)}px`;
  menu.style.top = `${Math.max(pad, top)}px`;
}

function hideContextMenu() {
  $("file-context-menu")?.classList.add("hidden");
}

async function mkdirOn(side) {
  const name = await askText({
    title: "新建文件夹",
    message: "请输入文件夹名称",
    placeholder: "new-folder",
  });
  if (!name || !name.trim()) return;
  const ep = state.endpoints[side];
  const base = panePath(side);
  const full = joinPath(base, name.trim());
  if (ep.kind === "local") {
    await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ scope: "local", path: full }) });
  } else {
    if (!ep.hostId) throw new Error("请先选择主机");
    await api("/api/fs/mkdir", {
      method: "POST",
      body: JSON.stringify({ scope: "remote", id: ep.hostId, path: full }),
    });
  }
  await refreshPane(side);
}

async function renameEntry(side, entry) {
  if (!entry) return;
  const next = await askText({
    title: "重命名",
    message: `当前名称：${entry.name}`,
    defaultValue: entry.name,
  });
  if (!next || !next.trim() || next.trim() === entry.name) return;
  const parent = entry.path.replace(/\/[^/]+\/?$/, "") || "/";
  const to = joinPath(parent === entry.path ? panePath(side) : parent, next.trim());
  const ep = state.endpoints[side];
  if (ep.kind === "local") {
    await api("/api/fs/rename", {
      method: "POST",
      body: JSON.stringify({ scope: "local", from: entry.path, to }),
    });
  } else {
    if (!ep.hostId) throw new Error("请先选择主机");
    await api("/api/fs/rename", {
      method: "POST",
      body: JSON.stringify({ scope: "remote", id: ep.hostId, from: entry.path, to }),
    });
  }
  state.paneSelected[side] = [];
  await refreshPane(side);
}

async function deleteEntries(side, entries) {
  const list = (entries || selectedEntries(side)).filter(Boolean);
  if (!list.length) return;
  const ok = await askConfirm({
    title: "删除确认",
    message: `确定删除 ${list.length} 项？\n${list
      .slice(0, 5)
      .map((e) => e.name)
      .join("\n")}${list.length > 5 ? "\n…" : ""}\n此操作不可恢复。`,
    okText: "删除",
  });
  if (!ok) return;
  const ep = state.endpoints[side];
  for (const entry of list) {
    if (ep.kind === "local") {
      await api("/api/fs/delete", {
        method: "POST",
        body: JSON.stringify({ scope: "local", path: entry.path }),
      });
    } else {
      if (!ep.hostId) throw new Error("请先选择主机");
      await api("/api/fs/delete", {
        method: "POST",
        body: JSON.stringify({
          scope: "remote",
          id: ep.hostId,
          path: entry.path,
          isDir: entry.type === "dir",
        }),
      });
    }
  }
  state.paneSelected[side] = [];
  await refreshPane(side);
}

async function chmodEntry(side, entry) {
  if (!entry) return;
  const mode = await askText({
    title: "修改权限",
    message: `文件：${entry.name}\n当前权限：${entry.perm || "未知"}\n请输入八进制权限，如 755 / 644`,
    defaultValue: entry.type === "dir" ? "755" : "644",
  });
  if (!mode || !String(mode).trim()) return;
  const ep = state.endpoints[side];
  if (ep.kind === "local") {
    await api("/api/fs/chmod", {
      method: "POST",
      body: JSON.stringify({ scope: "local", path: entry.path, mode: String(mode).trim() }),
    });
  } else {
    if (!ep.hostId) throw new Error("请先选择主机");
    await api("/api/fs/chmod", {
      method: "POST",
      body: JSON.stringify({
        scope: "remote",
        id: ep.hostId,
        path: entry.path,
        mode: String(mode).trim(),
      }),
    });
  }
  await refreshPane(side);
}

async function selectHost(id, mode = "both", opts = {}) {
  const { fromBus = false } = opts;
  state.activeId = id;
  const sess = ensureSession(id);

  if (mode === "sftp") {
    state.layout.sftp = true;
    state.layout.term = false;
  } else if (mode === "term") {
    state.layout.sftp = false;
    state.layout.term = true;
  } else {
    state.layout.sftp = true;
    state.layout.term = true;
  }

  if (!fromBus) {
    publish({ type: "selectHost", id, mode });
  }

  // 主机侧栏只负责选主机，不渲染工作区
  if (state.panel === "hosts") {
    renderHosts();
    return;
  }

  // 从主机列表点「文件/默认」时：右侧切到该主机，左侧默认保持本地（可再改成另一台主机）
  if (mode === "sftp" || mode === "both") {
    state.endpoints.right = { kind: "host", hostId: id };
    if (sameEndpoint(state.endpoints.left, state.endpoints.right)) {
      state.endpoints.left = { kind: "local", hostId: null };
    }
  }

  renderHosts();
  renderSourceMenus();
  updateRightEmpty();
  updateActiveLabels();
  updateLayoutChrome();
  showTerminalMount(id);

  $("remote-path").value = sess.remotePath || ".";

  if (state.layout.sftp) {
    await refreshPane("left");
    await refreshPane("right");
  }
  if (state.layout.term) {
    if (sess.term || mode === "term") {
      connectTerminal(id);
    } else {
      updateTermStatus(sess);
      $("term-placeholder").classList.toggle("hidden", Boolean(sess.term));
    }
  }
}

function openHostDialog(host) {
  const dlg = $("host-dialog");
  const form = $("host-form");
  form.id.value = host?.id || "";
  form.name.value = host?.name || "";
  form.host.value = host?.host || "";
  form.port.value = host?.port || 22;
  form.username.value = host?.username || "";
  form.privateKeyPath.value = host?.privateKeyPath || "";
  form.password.value = "";
  form.passphrase.value = "";
  form.defaultCwd.value = host?.defaultCwd || "";
  form.id.readOnly = Boolean(host);
  $("dialog-title").textContent = host ? "编辑主机" : "新建主机";
  $("btn-delete-host").style.display = host ? "inline-block" : "none";
  dlg.showModal();
}

function setupDialog() {
  $("btn-dialog-close").addEventListener("click", () => $("host-dialog").close());

  $("host-form").addEventListener("submit", async (e) => {
    const submitter = e.submitter;
    if (submitter && submitter.value === "cancel") return;
    e.preventDefault();
    const form = e.target;
    const payload = {
      id: form.id.value.trim(),
      name: form.name.value.trim(),
      host: form.host.value.trim(),
      port: Number(form.port.value || 22),
      username: form.username.value.trim(),
      privateKeyPath: form.privateKeyPath.value.trim(),
      defaultCwd: form.defaultCwd.value.trim(),
    };
    if (form.password.value) payload.password = form.password.value;
    if (form.passphrase.value) payload.passphrase = form.passphrase.value;
    await api("/api/hosts", { method: "POST", body: JSON.stringify(payload) });
    $("host-dialog").close();
    await refreshHosts();
    publish({ type: "hostsChanged" });
  });

  $("btn-delete-host").addEventListener("click", async () => {
    const form = $("host-form");
    const id = form.id.value.trim();
    if (!id) return;
    $("host-dialog").close();
    await deleteHost(id, form.name.value.trim() || id);
  });
}

function setupPanelControls() {
  $("btn-close-sftp").addEventListener("click", () => {
    if (!state.layout.term) return;
    state.layout.sftp = false;
    updateLayoutChrome();
  });
  $("btn-close-term").addEventListener("click", () => {
    if (!state.layout.sftp) return;
    state.layout.term = false;
    updateLayoutChrome();
  });
  $("btn-show-sftp").addEventListener("click", () => {
    state.layout.sftp = true;
    updateLayoutChrome();
    if (state.activeId) refreshRemote();
  });
  $("btn-show-term").addEventListener("click", () => {
    state.layout.term = true;
    updateLayoutChrome();
    if (state.activeId) {
      showTerminalMount(state.activeId);
      const sess = ensureSession(state.activeId);
      if (sess.term || sess.status === "online") connectTerminal(state.activeId);
      fitActiveTerminal();
    }
  });
  $("btn-term-clear").addEventListener("click", () => {
    const sess = state.activeId ? state.sessions[state.activeId] : null;
    if (sess?.term) sess.term.clear();
  });

  const handle = $("panel-resize");
  const pane = $("term-pane");
  let startY = 0;
  let startH = 0;
  handle.addEventListener("mousedown", (e) => {
    startY = e.clientY;
    startH = pane.getBoundingClientRect().height;
    const onMove = (ev) => {
      const dy = startY - ev.clientY;
      const next = Math.max(120, Math.min(window.innerHeight * 0.75, startH + dy));
      state.layout.termHeight = next;
      pane.style.height = `${next}px`;
      fitActiveTerminal();
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  window.addEventListener("resize", fitActiveTerminal);
}

function setupColResize() {
  const order = ["name", "mtime", "size", "kind"];
  const minPct = { name: 22, mtime: 10, size: 8, kind: 8 };

  const onMove = (ev) => {
    const drag = state.colResize;
    if (!drag) return;
    const dx = ev.clientX - drag.startX;
    const deltaPct = (dx / drag.tableWidth) * 100;
    let left = drag.startLeft + deltaPct;
    let right = drag.startRight - deltaPct;
    if (left < minPct[drag.leftKey]) {
      right -= minPct[drag.leftKey] - left;
      left = minPct[drag.leftKey];
    }
    if (right < minPct[drag.rightKey]) {
      left -= minPct[drag.rightKey] - right;
      right = minPct[drag.rightKey];
    }
    if (left < minPct[drag.leftKey] || right < minPct[drag.rightKey]) return;
    state.colWidths[drag.leftKey] = Math.round(left * 10) / 10;
    state.colWidths[drag.rightKey] = Math.round(right * 10) / 10;
    applyColWidths();
  };

  const onUp = () => {
    if (!state.colResize) return;
    state.colResize.handle?.classList.remove("active");
    state.colResize = null;
    document.body.classList.remove("col-resizing");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    saveColWidths();
  };

  document.querySelectorAll(".file-table .col-resizer").forEach((handle) => {
    handle.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const table = handle.closest(".file-table");
      const leftKey = handle.getAttribute("data-resize");
      const idx = order.indexOf(leftKey);
      if (!table || idx < 0 || idx >= order.length - 1) return;
      const rightKey = order[idx + 1];
      handle.classList.add("active");
      document.body.classList.add("col-resizing");
      state.colResize = {
        leftKey,
        rightKey,
        startX: ev.clientX,
        startLeft: state.colWidths[leftKey],
        startRight: state.colWidths[rightKey],
        tableWidth: table.getBoundingClientRect().width || 1,
        handle,
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  });
  applyColWidths();
}

function setupTransfers() {
  setupColResize();
  // 委托：来源切换 / 面包屑 / 排序 / 操作按钮
  $("sftp-split")?.addEventListener("click", async (e) => {
    const opt = e.target.closest(".source-option");
    if (opt) {
      e.preventDefault();
      e.stopPropagation();
      const pane = opt.closest("[data-side]");
      const side = pane?.getAttribute("data-side");
      if (!side) return;
      await setEndpoint(side, opt.getAttribute("data-kind"), opt.getAttribute("data-id"));
      return;
    }
    const btn = e.target.closest(".pane-source-btn");
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      const pane = btn.closest("[data-side]");
      const side = pane?.getAttribute("data-side");
      if (!side) return;
      const menu = paneDom(side).menu;
      const wasOpen = menu && !menu.classList.contains("hidden");
      closeSourceMenus();
      renderSourceMenus();
      if (!wasOpen) paneDom(side).menu?.classList.remove("hidden");
      return;
    }
    const crumb = e.target.closest(".crumb-item");
    if (crumb) {
      const side = crumb.getAttribute("data-side");
      const p = crumb.getAttribute("data-path");
      if (!side || !p) return;
      if (state.endpoints[side].kind === "local") {
        state.localPath = p;
        paneDom(side).path.value = p;
      } else if (state.endpoints[side].hostId) {
        ensureSession(state.endpoints[side].hostId).remotePath = p;
        paneDom(side).path.value = p;
      }
      await refreshPane(side);
      return;
    }
    if (e.target.closest(".col-resizer")) return;
    const sortTh = e.target.closest("th.sortable");
    if (sortTh) {
      const table = sortTh.closest(".file-table");
      const side = table?.getAttribute("data-side");
      const key = sortTh.getAttribute("data-sort");
      if (!side || !key) return;
      const cur = state.paneSort[side];
      state.paneSort[side] =
        cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
      renderFileList(side);
      return;
    }
    const act = e.target.closest("[data-act]");
    if (act) {
      const side = act.getAttribute("data-side");
      const kind = act.getAttribute("data-act");
      if (kind === "refresh" && side) await refreshPane(side);
      if (kind === "mkdir" && side) await mkdirOn(side);
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("#file-context-menu")) return;
    if (e.target.closest(".app-modal")) return;
    // 右键后浏览器可能紧跟一次 click，避免菜单刚打开就被关掉
    if (Date.now() - (state.ctxOpenedAt || 0) < 280) return;
    closeSourceMenus();
    hideContextMenu();
  });
  document.addEventListener("contextmenu", (e) => {
    if (e.target.closest("#file-context-menu")) return;
    if (e.target.closest(".file-table-wrap")) return;
    hideContextMenu();
  });
  ["left", "right"].forEach((side) => {
    const wrap = paneDom(side).list?.closest(".file-table-wrap");
    wrap?.addEventListener("contextmenu", (ev) => {
      if (ev.target.closest("tr[data-path]")) return;
      ev.preventDefault();
      ev.stopPropagation();
      state.ctx = { side, entry: null };
      showContextMenu(ev.clientX, ev.clientY);
    });
  });

  $("sftp-show-hidden")?.addEventListener("change", (e) => {
    state.showHidden = Boolean(e.target.checked);
    localStorage.setItem("cursor-ssh-mcp-show-hidden", state.showHidden ? "1" : "0");
    renderFileList("left");
    renderFileList("right");
  });
  if ($("sftp-show-hidden")) $("sftp-show-hidden").checked = state.showHidden;

  ["left", "right"].forEach((side) => {
    const input = $(side === "left" ? "left-filter" : "right-filter");
    input?.addEventListener("input", (e) => {
      state.paneFilter[side] = e.target.value || "";
      renderFileList(side);
    });
  });

  $("btn-pick-right-host")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeSourceMenus();
    renderSourceMenus();
    $("right-source-menu")?.classList.remove("hidden");
  });

  $("file-context-menu")?.addEventListener("mousedown", (e) => {
    // 阻止菜单上的按下事件冒泡到 document 导致先关闭
    e.stopPropagation();
  });
  $("file-context-menu")?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.target.closest("[data-ctx]");
    if (!btn || btn.disabled) return;
    const act = btn.getAttribute("data-ctx");
    const side = state.ctx.side;
    const entry = state.ctx.entry;
    hideContextMenu();
    if (!side) return;
    try {
      if (act === "refresh") {
        await refreshPane(side);
        return;
      }
      if (act === "mkdir") {
        await mkdirOn(side);
        return;
      }
      if (act === "rename") {
        await renameEntry(side, entry);
        return;
      }
      if (act === "delete") {
        await deleteEntries(side, entry ? [entry] : selectedEntries(side));
        return;
      }
      if (act === "chmod") {
        await chmodEntry(side, entry);
        return;
      }
      if (act === "copy") {
        const other = side === "left" ? "right" : "left";
        const files = (entry ? [entry] : selectedEntries(side)).filter((x) => x.type === "file");
        await transferFiles(side, other, files);
        await refreshPane(side);
        await refreshPane(other);
      }
    } catch (err) {
      await askConfirm({
        title: "操作失败",
        message: err.message || String(err),
        okText: "知道了",
      });
    }
  });

  [
    ["local-list", "left"],
    ["remote-list", "right"],
  ].forEach(([id, toSide]) => {
    const el = $(id);
    if (!el) return;
    const wrap = el.closest(".file-table-wrap") || el;
    wrap.addEventListener("dragover", (e) => {
      e.preventDefault();
      wrap.classList.add("drop-target");
    });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("drop-target"));
    wrap.addEventListener("drop", async (e) => {
      e.preventDefault();
      wrap.classList.remove("drop-target");
      const raw = e.dataTransfer.getData("application/x-ssh-mcp");
      if (!raw) return;
      const payload = JSON.parse(raw);
      const files = payload.entries || (payload.entry ? [payload.entry] : []);
      if (!files.length || payload.side === toSide) return;
      state.paneSelected[payload.side] = files;
      await transferFiles(payload.side, toSide, files);
    });
  });
}

async function goPane(side) {
  const ep = state.endpoints[side];
  const dom = paneDom(side);
  const path = dom.path.value.trim();
  if (ep.kind === "local") {
    state.localPath = path;
  } else if (ep.hostId) {
    ensureSession(ep.hostId).remotePath = path || ".";
  }
  await refreshPane(side);
}

async function upPane(side) {
  const ep = state.endpoints[side];
  if (ep.kind === "local") {
    const data = await api(`/api/local/list?path=${encodeURIComponent(state.localPath)}`);
    state.localPath = data.parent;
    paneDom(side).path.value = state.localPath;
  } else if (ep.hostId) {
    const sess = ensureSession(ep.hostId);
    const data = await api(
      `/api/remote/list?id=${encodeURIComponent(ep.hostId)}&path=${encodeURIComponent(sess.remotePath || ".")}`
    );
    sess.remotePath = data.parent;
    paneDom(side).path.value = sess.remotePath;
  }
  await refreshPane(side);
}

function setupNav() {
  const openAdd = () => openHostDialog(null);
  $("btn-add").addEventListener("click", openAdd);
  $("btn-add-empty").addEventListener("click", openAdd);
  $("btn-refresh").addEventListener("click", () => refreshHosts());
  $("local-go").addEventListener("click", () => goPane("left"));
  $("remote-go").addEventListener("click", () => goPane("right"));
  $("local-up").addEventListener("click", () => upPane("left"));
  $("remote-up").addEventListener("click", () => upPane("right"));
}

function setupBus() {
  if (!bus) return;
  bus.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === "selectHost" && msg.id && state.panel !== "hosts") {
      selectHost(msg.id, msg.mode || "both", { fromBus: true });
    }
    if (msg.type === "hostsChanged") {
      refreshHosts();
    }
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return true;
  }
}

function sendToTerminal(cmd) {
  const sess = state.activeId ? state.sessions[state.activeId] : null;
  if (!sess?.ws || sess.ws.readyState !== WebSocket.OPEN || !sess.term) {
    copyText(cmd);
    alert("终端未连接，已复制命令到剪贴板");
    return;
  }
  sess.ws.send(JSON.stringify({ type: "input", data: `${cmd}\r` }));
  pushHistory(cmd);
}

function renderUtilThemes() {
  const box = $("util-theme");
  if (!box) return;
  const q = state.utilQuery.trim().toLowerCase();
  const list = THEMES.filter(
    (t) => t && t.id && (!q || t.name.toLowerCase().includes(q) || t.id.includes(q))
  );
  const prefs = state.termPrefs;
  const theme = currentTheme().theme;
  const fontOpts = FONT_PRESETS.map(
    (f) =>
      `<option value="${escapeHtml(f.value)}" ${f.value === prefs.fontFamily ? "selected" : ""}>${escapeHtml(f.label)}</option>`
  ).join("");
  const cards = list
    .map((t) => {
      const colors = [t.theme.background, t.theme.foreground, t.theme.green || t.theme.cyan, t.theme.cursor];
      return `<button type="button" class="theme-card ${t.id === state.themeId ? "active" : ""}" data-act="pick-theme" data-theme="${t.id}">
        <div class="theme-name">${escapeHtml(t.name)}</div>
        <div class="theme-swatches" aria-hidden="true">${colors
          .map((c) => `<span style="background:${c}"></span>`)
          .join("")}</div>
      </button>`;
    })
    .join("");
  box.innerHTML = `
    <div class="theme-editor">
      <div class="theme-editor-title">终端外观</div>
      <label class="theme-field">字体
        <select id="term-font-family">${fontOpts}</select>
      </label>
      <label class="theme-field">字号
        <input id="term-font-size" type="range" min="11" max="22" step="1" value="${Number(prefs.fontSize) || 13}" />
        <span id="term-font-size-val">${Number(prefs.fontSize) || 13}px</span>
      </label>
      <label class="theme-field">行高
        <input id="term-line-height" type="range" min="1" max="1.8" step="0.05" value="${Number(prefs.lineHeight) || 1.2}" />
        <span id="term-line-height-val">${Number(prefs.lineHeight) || 1.2}</span>
      </label>
      <div class="theme-colors">
        <label>背景 <input id="term-bg" type="color" value="${theme.background || "#10211e"}" /></label>
        <label>文字 <input id="term-fg" type="color" value="${theme.foreground || "#d7ebe6"}" /></label>
        <label>光标 <input id="term-cursor" type="color" value="${theme.cursor || "#5eead4"}" /></label>
      </div>
      <label class="theme-check"><input id="term-cursor-blink" type="checkbox" ${prefs.cursorBlink ? "checked" : ""}/> 光标闪烁</label>
      <button type="button" class="btn-util primary" data-act="apply-term-prefs">应用到终端</button>
    </div>
    <div class="theme-list">${cards}</div>`;
}

function renderUtilHistory() {
  const box = $("util-history");
  if (!box) return;
  const q = state.utilQuery.trim().toLowerCase();
  const list = state.history.filter((c) => !q || c.toLowerCase().includes(q));
  if (!list.length) {
    box.innerHTML = `<div class="util-empty">暂无历史命令。连接终端并执行命令后会自动记录。</div>`;
    return;
  }
  box.innerHTML = list
    .map(
      (cmd, idx) => `<div class="hist-item" data-idx="${idx}">
      <div class="hist-cmd">${escapeHtml(cmd)}</div>
      <div class="hist-actions">
        <button type="button" class="btn-util" data-act="copy">复制</button>
        <button type="button" class="btn-util primary" data-act="run">发送到终端</button>
      </div>
    </div>`
    )
    .join("");
  box.querySelectorAll(".hist-item").forEach((el) => {
    const cmd = list[Number(el.getAttribute("data-idx"))];
    el.querySelector('[data-act="copy"]').addEventListener("click", () => copyText(cmd));
    el.querySelector('[data-act="run"]').addEventListener("click", () => sendToTerminal(cmd));
  });
}

const DICT_SYNONYMS = {
  导出sql: ["mysqldump", "pg_dump", "导出库", "导出表", "dump", "sqlite3", ".dump"],
  导出: ["mysqldump", "pg_dump", "dump", "导出库", "备份"],
  导入sql: ["mysql <", "psql", "导入", "restore"],
  导入: ["mysql <", "psql -f", "mongorestore", "导入"],
  查端口: ["ss -lntp", "端口占用", "lsof"],
  看日志: ["tail -f", "journalctl", "日志"],
  内存: ["free -h", "jmap", "heap", "内存"],
  死锁: ["jstack", "线程栈", "deadlock"],
  虚拟环境: ["venv", "conda", "poetry", "virtualenv"],
  打包: ["mvn", "gradle", "package", "build", "tar", "zip"],
};

function expandQueryTerms(raw) {
  const q = String(raw || "").trim().toLowerCase();
  if (!q) return [];
  const terms = new Set([q]);
  Object.entries(DICT_SYNONYMS).forEach(([k, vals]) => {
    if (q.includes(k) || k.includes(q)) {
      terms.add(k);
      vals.forEach((v) => terms.add(String(v).toLowerCase()));
    }
  });
  // 去掉空白再切中文/英文碎片
  q.split(/[\s/|,.，。]+/).filter(Boolean).forEach((t) => terms.add(t));
  (q.match(/[a-zA-Z][\w.+-]*/g) || []).forEach((t) => terms.add(t.toLowerCase()));
  return [...terms];
}

function matchDictItem(item, q) {
  if (!q) return true;
  const hay = `${item.name}\n${item.desc}\n${item.cmd}\n${item.cat}`.toLowerCase();
  const terms = expandQueryTerms(q);
  return terms.some((t) => t && hay.includes(t));
}

function onlineTopicFromQuery(raw) {
  const q = String(raw || "").trim();
  if (!q) return "linux";
  // cheat.sh 更适合英文命令名
  if (/^[a-zA-Z][\w.+-]*$/.test(q)) return q;
  const embedded = q.match(/[a-zA-Z][\w.+-]*/);
  if (embedded) return embedded[0];
  const terms = expandQueryTerms(q);
  const eng = terms.find((t) => /^[a-z][\w.+-]*$/i.test(t));
  return eng || "linux";
}

function groupDictByCat(list) {
  const map = new Map();
  list.forEach((item) => {
    if (!map.has(item.cat)) map.set(item.cat, []);
    map.get(item.cat).push(item);
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh"));
}

function dictItemHtml(item, key) {
  return `<div class="dict-item" data-key="${escapeHtml(key)}">
    <div class="dict-title">
      <span class="dict-name">${escapeHtml(item.name)}</span>
    </div>
    <div class="dict-desc">${escapeHtml(item.desc)}</div>
    <div class="dict-cmd">${escapeHtml(item.cmd)}</div>
    <div class="dict-actions">
      <button type="button" class="btn-util" data-act="copy">复制</button>
      <button type="button" class="btn-util primary" data-act="run">发送</button>
    </div>
  </div>`;
}

function bindDictItemActions(root, listByKey) {
  root.querySelectorAll(".dict-item").forEach((el) => {
    const item = listByKey[el.getAttribute("data-key")];
    if (!item) return;
    el.querySelector('[data-act="copy"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(item.cmd);
    });
    el.querySelector('[data-act="run"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      sendToTerminal(item.cmd);
    });
  });
}

function suggestOnlineTopics(raw) {
  const q = String(raw || "").trim();
  if (!q) return ["linux"];
  const terms = expandQueryTerms(q);
  const eng = terms.filter((t) => /^[a-z][\w.+-]*$/i.test(t));
  const primary = onlineTopicFromQuery(q);
  const uniq = [];
  [primary, ...eng, "bash"].forEach((t) => {
    const v = String(t || "").trim();
    if (v && !uniq.includes(v)) uniq.push(v);
  });
  return uniq.slice(0, 5);
}

function onlinePanelHtml(keyword, opts = {}) {
  const soft = Boolean(opts.soft);
  const topics = suggestOnlineTopics(keyword);
  const chips = topics
    .map(
      (t, i) =>
        `<button type="button" class="topic-chip ${i === 0 ? "active" : ""}" data-act="cheat-topic" data-topic="${escapeHtml(t)}">${escapeHtml(t)}</button>`
    )
    .join("");
  return `
    <div class="online-miss ${soft ? "soft" : ""}">
      <div class="online-miss-title">${soft ? "本地已有结果，仍可联网补充" : `本地没有「${escapeHtml(keyword)}」`}</div>
      <div class="online-miss-sub">先选主题，再查 cheat.sh（经本机 UI 代理，无 CORS）</div>
      <div class="topic-chips">${chips}</div>
      <button type="button" class="btn-util primary" data-act="cheat" id="btn-cheat-query" data-topic="${escapeHtml(topics[0] || "linux")}">联网查询</button>
    </div>
    <div id="util-online-result"></div>`;
}

async function queryCheatOnline(q, topicOverride) {
  let box = $("util-online-result");
  if (!box) {
    const host = $("util-dict");
    if (!host) return;
    box = document.createElement("div");
    box.id = "util-online-result";
    host.appendChild(box);
  }
  const topic = String(topicOverride || state.dictOnlineTopic || onlineTopicFromQuery(q)).trim() || "linux";
  state.dictOnlineTopic = topic;
  document.querySelectorAll(".topic-chip").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-topic") === topic);
  });
  const trigger = $("btn-cheat-query");
  if (trigger) {
    trigger.disabled = true;
    trigger.textContent = "查询中…";
    trigger.dataset.topic = topic;
  }
  box.innerHTML = `<div class="util-empty">正在查询 <code>${escapeHtml(topic)}</code>…</div>`;
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  try {
    const data = await api(`/api/cheat?q=${encodeURIComponent(topic)}`);
    const text = String(data.text || "").trim();
    box.innerHTML = `
      <div class="online-card">
        <div class="online-head">
          <strong>${escapeHtml(topic)}</strong>
          <a href="${escapeHtml(data.url)}" target="_blank" rel="noreferrer">cheat.sh</a>
        </div>
        <pre class="online-pre">${escapeHtml(text || "(空结果)")}</pre>
        <div class="dict-actions">
          <button type="button" class="btn-util" data-act="online-copy">复制</button>
          <button type="button" class="btn-util primary" data-act="online-send">发送到终端</button>
        </div>
      </div>`;
    box.querySelector('[data-act="online-copy"]')?.addEventListener("click", () => copyText(text));
    box.querySelector('[data-act="online-send"]')?.addEventListener("click", () => {
      const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
      sendToTerminal(firstLine || text);
    });
    if (trigger) {
      trigger.disabled = false;
      trigger.textContent = "重新查询";
    }
  } catch (err) {
    box.innerHTML = `<div class="util-empty online-error">联网失败：${escapeHtml(err.message)}<br/><a href="https://cheat.sh/${encodeURIComponent(topic)}" target="_blank" rel="noreferrer">浏览器打开 cheat.sh/${escapeHtml(topic)}</a></div>`;
    if (trigger) {
      trigger.disabled = false;
      trigger.textContent = "重试";
    }
  }
}

function scheduleAutoOnline(keyword) {
  if (state.dictOnlineTimer) clearTimeout(state.dictOnlineTimer);
  const q = String(keyword || "").trim();
  if (q.length < 2) return;
  state.dictOnlineTimer = setTimeout(() => {
    if (state.utilTab !== "dict") return;
    if (state.utilQuery.trim() !== q) return;
    const topic = state.dictOnlineTopic || onlineTopicFromQuery(q);
    queryCheatOnline(q, topic);
  }, 450);
}

function renderUtilDict() {
  const box = $("util-dict");
  if (!box) return;
  const all = window.LINUX_COMMANDS || [];
  const raw = state.utilQuery.trim();
  const q = raw.toLowerCase();
  const list = all.filter((item) => matchDictItem(item, q));
  const groups = groupDictByCat(list);
  const openCats = state.dictOpenCats || new Set();
  if (q) groups.forEach(([cat]) => openCats.add(cat));
  state.dictOpenCats = openCats;

  if (!raw) {
    const flatKeys = {};
    let html = `<div class="dict-meta">本地 ${list.length} 条 · 输入关键词先查本地</div><div class="dict-tree">`;
    groups.slice(0, 8).forEach(([cat, items]) => {
      const open = openCats.has(cat);
      html += `<details class="dict-branch" data-cat="${escapeHtml(cat)}" ${open ? "open" : ""}>
        <summary><span class="branch-name">${escapeHtml(cat)}</span><span class="branch-count">${items.length}</span></summary>
        <div class="branch-body">`;
      items.slice(0, 6).forEach((item, i) => {
        const key = `${cat}::${i}::${item.name}`;
        flatKeys[key] = item;
        html += dictItemHtml(item, key);
      });
      html += `</div></details>`;
    });
    html += `</div>`;
    box.innerHTML = html;
    box.querySelectorAll("details.dict-branch").forEach((el) => {
      el.addEventListener("toggle", () => {
        const cat = el.getAttribute("data-cat");
        if (el.open) state.dictOpenCats.add(cat);
        else state.dictOpenCats.delete(cat);
      });
    });
    bindDictItemActions(box, flatKeys);
    return;
  }

  if (!list.length) {
    state.dictOnlineTopic = suggestOnlineTopics(raw)[0] || "linux";
    box.innerHTML = onlinePanelHtml(raw, { soft: false });
    scheduleAutoOnline(raw);
    return;
  }

  const flatKeys = {};
  let html = `<div class="dict-meta">本地 ${list.length} 条</div><div class="dict-tree">`;
  groups.forEach(([cat, items]) => {
    const open = openCats.has(cat);
    html += `<details class="dict-branch" data-cat="${escapeHtml(cat)}" ${open ? "open" : ""}>
      <summary><span class="branch-name">${escapeHtml(cat)}</span><span class="branch-count">${items.length}</span></summary>
      <div class="branch-body">`;
    items.forEach((item, i) => {
      const key = `${cat}::${i}::${item.name}`;
      flatKeys[key] = item;
      html += dictItemHtml(item, key);
    });
    html += `</div></details>`;
  });
  html += `</div>`;
  state.dictOnlineTopic = suggestOnlineTopics(raw)[0] || "linux";
  html += onlinePanelHtml(raw, { soft: true });
  box.innerHTML = html;

  box.querySelectorAll("details.dict-branch").forEach((el) => {
    el.addEventListener("toggle", () => {
      const cat = el.getAttribute("data-cat");
      if (el.open) state.dictOpenCats.add(cat);
      else state.dictOpenCats.delete(cat);
    });
  });
  bindDictItemActions(box, flatKeys);
}

function renderUtilActive() {
  if (state.utilTab === "theme") renderUtilThemes();
  if (state.utilTab === "history") renderUtilHistory();
  if (state.utilTab === "dict") renderUtilDict();
}

function applyUtilCollapsed() {
  document.body.classList.toggle("util-collapsed", Boolean(state.utilCollapsed));
  localStorage.setItem("cursor-ssh-mcp-util-collapsed", state.utilCollapsed ? "1" : "0");
  const rail = $("util-rail");
  // 清掉 resize 残留的 inline 宽度，避免收起后再展开仍卡在 36px
  if (rail) {
    rail.style.width = "";
    rail.style.minWidth = "";
    rail.style.maxWidth = "";
  }
  const toggle = $("btn-toggle-util");
  if (toggle) {
    toggle.textContent = state.utilCollapsed ? "工具" : "收起工具";
    toggle.title = state.utilCollapsed ? "展开右侧工具栏" : "收起右侧工具栏，把空间留给终端";
  }
  // 收起/展开后终端需要重新 fit
  requestAnimationFrame(() => {
    fitActiveTerminal();
    setTimeout(() => fitActiveTerminal(), 200);
  });
}

function setUtilCollapsed(collapsed) {
  state.utilCollapsed = Boolean(collapsed);
  applyUtilCollapsed();
}

function setupUtilRail() {
  if (!$("util-rail")) return;
  loadHistory();
  applyUtilCollapsed();
  // 预览用：若没有历史，放几条示例方便先看效果
  if (!state.history.length) {
    state.history = [
      "tail -f /var/log/syslog",
      "ss -lntp",
      "df -h",
      "docker ps",
      "systemctl status nginx",
    ];
  }
  $("btn-collapse-util")?.addEventListener("click", () => setUtilCollapsed(true));
  $("util-expand-tab")?.addEventListener("click", () => setUtilCollapsed(false));
  $("btn-toggle-util")?.addEventListener("click", () => setUtilCollapsed(!state.utilCollapsed));
  document.querySelectorAll(".util-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.utilTab = btn.getAttribute("data-util");
      document.querySelectorAll(".util-tab").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".util-panel").forEach((p) => {
        p.classList.toggle("active", p.id === `util-${state.utilTab}`);
      });
      const placeholders = {
        theme: "搜索主题…",
        history: "搜索历史命令…",
        dict: "搜索命令 / 说明 / 分类…",
      };
      $("util-search").placeholder = placeholders[state.utilTab] || "搜索…";
      renderUtilActive();
    });
  });
  $("util-search").addEventListener("input", (e) => {
    state.utilQuery = e.target.value || "";
    renderUtilActive();
  });
  // 委托绑定：联网主题 / 查询按钮
  $("util-dict")?.addEventListener("click", (e) => {
    const topicBtn = e.target.closest("[data-act='cheat-topic']");
    if (topicBtn) {
      e.preventDefault();
      e.stopPropagation();
      const topic = topicBtn.getAttribute("data-topic") || "linux";
      state.dictOnlineTopic = topic;
      document.querySelectorAll(".topic-chip").forEach((el) => {
        el.classList.toggle("active", el === topicBtn);
      });
      const main = $("btn-cheat-query");
      if (main) main.dataset.topic = topic;
      queryCheatOnline(state.utilQuery.trim() || topic, topic);
      return;
    }
    const btn = e.target.closest("[data-act='cheat'], #btn-cheat-query");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const topic = btn.getAttribute("data-topic") || state.dictOnlineTopic || onlineTopicFromQuery(state.utilQuery);
    queryCheatOnline(state.utilQuery.trim() || topic, topic);
  });

  // 主题卡片 + 外观调节（委托，避免列表重建后失效）
  $("util-theme")?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-act='pick-theme']");
    if (card) {
      e.preventDefault();
      state.themeId = card.getAttribute("data-theme");
      localStorage.setItem("cursor-ssh-mcp-theme", state.themeId);
      applyThemeToAll();
      renderUtilThemes();
      return;
    }
    if (e.target.closest("[data-act='apply-term-prefs']")) {
      e.preventDefault();
      const font = $("term-font-family")?.value;
      const size = Number($("term-font-size")?.value || 13);
      const lh = Number($("term-line-height")?.value || 1.2);
      const blink = Boolean($("term-cursor-blink")?.checked);
      const bg = $("term-bg")?.value;
      const fg = $("term-fg")?.value;
      const cursor = $("term-cursor")?.value;
      state.termPrefs = {
        fontFamily: font || state.termPrefs.fontFamily,
        fontSize: size,
        lineHeight: lh,
        cursorBlink: blink,
      };
      saveTermPrefs();
      // 覆盖当前主题的背景/文字/光标色
      const base = currentTheme();
      const customId = "custom-live";
      const custom = {
        id: customId,
        name: "自定义",
        theme: {
          ...base.theme,
          background: bg || base.theme.background,
          foreground: fg || base.theme.foreground,
          cursor: cursor || base.theme.cursor,
        },
      };
      const idx = THEMES.findIndex((t) => t.id === customId);
      if (idx >= 0) THEMES[idx] = custom;
      else THEMES.unshift(custom);
      state.themeId = customId;
      localStorage.setItem("cursor-ssh-mcp-theme", customId);
      applyThemeToAll();
      renderUtilThemes();
    }
  });
  $("util-theme")?.addEventListener("input", (e) => {
    if (e.target?.id === "term-font-size") {
      const val = $("term-font-size-val");
      if (val) val.textContent = `${e.target.value}px`;
    }
    if (e.target?.id === "term-line-height") {
      const val = $("term-line-height-val");
      if (val) val.textContent = e.target.value;
    }
  });

  applyThemeToAll();
  renderUtilActive();
}

async function main() {
  setupBus();
  setupDialog();
  if (state.panel !== "hosts") {
    setupPanelControls();
    setupTransfers();
    setupUtilRail();
  }
  setupNav();
  if (state.panel !== "hosts") updateLayoutChrome();
  await refreshHosts();
  if (state.panel !== "hosts") {
    const stored = readStoredSelection();
    if (stored?.type === "selectHost" && stored.id) {
      await selectHost(stored.id, stored.mode || "both", { fromBus: true });
    } else if (state.hosts[0]) {
      state.endpoints.right = { kind: "host", hostId: state.hosts[0].id };
      state.activeId = state.hosts[0].id;
      renderSourceMenus();
      await refreshPane("left");
      await refreshPane("right");
      updateActiveLabels();
    } else {
      renderSourceMenus();
      await refreshPane("left");
      await refreshPane("right");
    }
  }
}

main().catch((err) => {
  console.error(err);
  alert(err.message);
});
