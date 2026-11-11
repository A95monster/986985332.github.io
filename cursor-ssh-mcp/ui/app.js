/* global Terminal, FitAddon */
const STATUS = {
  idle: { label: "未连接", cls: "idle" },
  connecting: { label: "连接中", cls: "connecting" },
  connected: { label: "已连接", cls: "connected" },
  error: { label: "异常", cls: "error" },
};

const state = {
  hosts: [],
  activeId: null,
  defaultId: localStorage.getItem("ssh-mcp-default-host") || null,
  localPath: "/",
  remotePath: ".",
  localSelected: null,
  remoteSelected: null,
  sessions: new Map(), // hostId -> { term, fit, ws, mountEl, status, onDataDisposable, onResizeDisposable }
  sftpVisible: true,
  termVisible: true,
  termHeightPx: null,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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

function sessionStatus(id) {
  const session = state.sessions.get(id);
  return session ? session.status : "idle";
}

function setSessionStatus(id, status) {
  const session = state.sessions.get(id);
  if (session) session.status = status;
  renderHosts();
}

function renderHosts() {
  const ul = $("host-list");
  ul.innerHTML = "";
  state.hosts.forEach((h) => {
    const st = STATUS[sessionStatus(h.id)] || STATUS.idle;
    const li = document.createElement("li");
    li.className = "host-card" + (h.id === state.activeId ? " active" : "");
    li.dataset.id = h.id;
    const defaultMark = state.defaultId === h.id ? " · 默认" : "";
    li.innerHTML = `
      <div class="host-card-top">
        <div class="name">${escapeHtml(h.name || h.id)}${defaultMark}</div>
        <span class="status-pill ${st.cls}">${st.label}</span>
      </div>
      <div class="meta">${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port || 22}</div>
      <div class="host-actions">
        <button type="button" data-action="files">文件</button>
        <button type="button" data-action="term" class="primary">终端</button>
        <button type="button" data-action="default">默认</button>
        <button type="button" data-action="disconnect">断开</button>
      </div>
    `;
    li.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      selectHost(h.id, { openFiles: true, openTerm: false });
    });
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openHostDialog(h);
    });
    li.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleHostAction(h.id, btn.dataset.action);
      });
    });
    ul.appendChild(li);
  });
}

async function handleHostAction(id, action) {
  if (action === "files") {
    showSftp(true);
    await selectHost(id, { openFiles: true, openTerm: false });
    return;
  }
  if (action === "term") {
    showTerm(true);
    await selectHost(id, { openFiles: false, openTerm: true });
    return;
  }
  if (action === "default") {
    state.defaultId = id;
    localStorage.setItem("ssh-mcp-default-host", id);
    showSftp(true);
    showTerm(true);
    await selectHost(id, { openFiles: true, openTerm: true });
    return;
  }
  if (action === "disconnect") {
    disconnectSession(id);
    if (state.activeId === id) {
      $("remote-list").innerHTML = "<li>已断开</li>";
      updateTermTitle();
    }
    renderHosts();
  }
}

async function refreshHosts() {
  const data = await api("/api/hosts");
  state.hosts = data.hosts || [];
  if (!state.localPath || state.localPath === "/") {
    state.localPath = data.home || "/";
    $("local-path").value = state.localPath;
  }
  renderHosts();
}

async function selectHost(id, { openFiles, openTerm }) {
  state.activeId = id;
  renderHosts();
  const host = state.hosts.find((h) => h.id === id);
  $("sftp-title").textContent = host
    ? `文件传输 — ${host.name || host.id}`
    : "文件传输";
  updateTermTitle();

  if (openFiles) {
    showSftp(true);
    try {
      const listing = await api(
        `/api/remote/list?id=${encodeURIComponent(id)}&path=${encodeURIComponent(state.remotePath || ".")}`
      );
      state.remotePath = listing.path;
      $("remote-path").value = listing.path;
      renderFileList($("remote-list"), listing.entries, "remote");
    } catch (err) {
      $("remote-list").innerHTML = `<li>${escapeHtml(err.message)}</li>`;
    }
  }

  if (openTerm) {
    showTerm(true);
    ensureSession(id);
    showSessionMount(id);
  } else {
    showSessionMount(state.sessions.has(id) ? id : null);
  }
}

function renderFileList(ul, entries, side) {
  ul.innerHTML = "";
  entries.forEach((e) => {
    const li = document.createElement("li");
    li.textContent = (e.type === "dir" ? "📁 " : "📄 ") + e.name;
    if (e.type === "dir") li.classList.add("dir");
    li.draggable = e.type === "file";
    li.addEventListener("click", () => {
      [...ul.children].forEach((c) => c.classList.remove("selected"));
      li.classList.add("selected");
      if (side === "local") state.localSelected = e;
      else state.remoteSelected = e;
    });
    li.addEventListener("dblclick", async () => {
      if (e.type !== "dir") return;
      if (side === "local") {
        state.localPath = e.path;
        $("local-path").value = e.path;
        await refreshLocal();
      } else {
        state.remotePath = e.path;
        $("remote-path").value = e.path;
        await refreshRemote();
      }
    });
    li.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData(
        "application/x-ssh-mcp",
        JSON.stringify({ side, entry: e })
      );
    });
    ul.appendChild(li);
  });
}

async function refreshLocal() {
  const data = await api(`/api/local/list?path=${encodeURIComponent(state.localPath)}`);
  state.localPath = data.path;
  $("local-path").value = data.path;
  renderFileList($("local-list"), data.entries, "local");
}

async function refreshRemote() {
  if (!state.activeId) return;
  const data = await api(
    `/api/remote/list?id=${encodeURIComponent(state.activeId)}&path=${encodeURIComponent(state.remotePath || ".")}`
  );
  state.remotePath = data.path;
  $("remote-path").value = data.path;
  renderFileList($("remote-list"), data.entries, "remote");
}

function updateTermTitle() {
  const host = state.hosts.find((h) => h.id === state.activeId);
  const session = state.activeId ? state.sessions.get(state.activeId) : null;
  if (!host) {
    $("term-title").textContent = "终端";
    return;
  }
  const st = STATUS[session ? session.status : "idle"];
  $("term-title").textContent = `终端 — ${host.name || host.id}（${st.label}）`;
}

function updateTermPlaceholder() {
  const ph = $("term-placeholder");
  if (!ph) return;
  ph.style.display = state.sessions.size === 0 ? "flex" : "none";
}

function createFitAddon() {
  if (typeof FitAddon !== "undefined" && FitAddon.FitAddon) {
    return new FitAddon.FitAddon();
  }
  if (typeof window.FitAddon !== "undefined" && window.FitAddon.FitAddon) {
    return new window.FitAddon.FitAddon();
  }
  throw new Error("未找到 xterm-addon-fit");
}

function ensureSession(id) {
  if (state.sessions.has(id)) {
    const existing = state.sessions.get(id);
    if (existing.ws && existing.ws.readyState <= WebSocket.OPEN) {
      return existing;
    }
    // reconnect if socket died
    connectTerminalSocket(existing, id);
    return existing;
  }

  const mountEl = document.createElement("div");
  mountEl.className = "term-mount hidden-mount";
  mountEl.dataset.hostId = id;
  $("terminals").appendChild(mountEl);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, "SF Mono", monospace',
    theme: {
      background: "#12332f",
      foreground: "#e7fffb",
      cursor: "#5eead4",
      selectionBackground: "#0f766e88",
    },
  });
  const fit = createFitAddon();
  term.loadAddon(fit);
  term.open(mountEl);

  const session = {
    term,
    fit,
    ws: null,
    mountEl,
    status: "connecting",
    onDataDisposable: null,
    onResizeDisposable: null,
  };
  state.sessions.set(id, session);
  updateTermPlaceholder();
  connectTerminalSocket(session, id);
  return session;
}

function connectTerminalSocket(session, id) {
  if (session.ws) {
    try {
      session.ws.onopen = null;
      session.ws.onmessage = null;
      session.ws.onclose = null;
      session.ws.onerror = null;
      if (session.ws.readyState <= WebSocket.OPEN) session.ws.close();
    } catch {
      /* ignore */
    }
  }
  if (session.onDataDisposable) {
    try {
      session.onDataDisposable.dispose();
    } catch {
      /* ignore */
    }
  }
  if (session.onResizeDisposable) {
    try {
      session.onResizeDisposable.dispose();
    } catch {
      /* ignore */
    }
  }

  session.status = "connecting";
  renderHosts();
  updateTermTitle();

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(
    `${proto}://${location.host}/ws/shell?id=${encodeURIComponent(id)}`
  );
  session.ws = ws;

  ws.onopen = () => {
    /* ready arrives from server after shell starts */
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "data") session.term.write(msg.data);
    if (msg.type === "error") {
      session.status = "error";
      session.term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
      renderHosts();
      updateTermTitle();
    }
    if (msg.type === "ready") {
      session.status = "connected";
      renderHosts();
      updateTermTitle();
      try {
        session.fit.fit();
      } catch {
        /* ignore */
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: session.term.cols,
            rows: session.term.rows,
          })
        );
      }
    }
  };

  ws.onclose = () => {
    if (session.status !== "idle") {
      session.status = session.status === "error" ? "error" : "idle";
    }
    renderHosts();
    updateTermTitle();
  };

  ws.onerror = () => {
    session.status = "error";
    renderHosts();
    updateTermTitle();
  };

  session.onDataDisposable = session.term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
  });

  session.onResizeDisposable = session.term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  });
}

function showSessionMount(id) {
  for (const [hid, session] of state.sessions) {
    const active = hid === id;
    session.mountEl.classList.toggle("active-mount", active);
    session.mountEl.classList.toggle("hidden-mount", !active);
    if (active) {
      requestAnimationFrame(() => {
        try {
          session.fit.fit();
        } catch {
          /* ignore */
        }
      });
    }
  }
  updateTermTitle();
}

function disconnectSession(id) {
  const session = state.sessions.get(id);
  if (!session) return;
  try {
    if (session.ws && session.ws.readyState <= WebSocket.OPEN) session.ws.close();
  } catch {
    /* ignore */
  }
  try {
    if (session.onDataDisposable) session.onDataDisposable.dispose();
    if (session.onResizeDisposable) session.onResizeDisposable.dispose();
  } catch {
    /* ignore */
  }
  try {
    session.term.dispose();
  } catch {
    /* ignore */
  }
  session.mountEl.remove();
  state.sessions.delete(id);
  updateTermPlaceholder();
  if (state.activeId === id) showSessionMount(null);
}

function syncRestoreBar() {
  const bar = $("panel-restore");
  const btnSftp = $("btn-restore-sftp");
  const btnTerm = $("btn-restore-term");
  const needBar = !state.sftpVisible || !state.termVisible;
  bar.classList.toggle("hidden", !needBar);
  btnSftp.classList.toggle("hidden", state.sftpVisible);
  btnTerm.classList.toggle("hidden", state.termVisible);
  $("term-resize").style.display =
    state.sftpVisible && state.termVisible ? "" : "none";
}

function showSftp(visible) {
  state.sftpVisible = visible;
  $("sftp-pane").classList.toggle("closed", !visible);
  if (visible && !state.termVisible) {
    $("sftp-pane").style.flex = "1";
  } else if (visible && state.termVisible) {
    $("sftp-pane").style.flex = "1";
  }
  syncRestoreBar();
}

function showTerm(visible) {
  state.termVisible = visible;
  $("term-pane").classList.toggle("closed", !visible);
  if (visible && state.termHeightPx) {
    $("term-pane").style.height = `${state.termHeightPx}px`;
  }
  syncRestoreBar();
  if (visible && state.activeId && state.sessions.has(state.activeId)) {
    showSessionMount(state.activeId);
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
  $("dialog-title").textContent = host ? "编辑主机" : "添加主机";
  $("btn-delete-host").style.display = host ? "inline-block" : "none";
  dlg.showModal();
}

function setupDialog() {
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
  });

  $("btn-delete-host").addEventListener("click", async () => {
    const id = $("host-form").id.value.trim();
    if (!id) return;
    if (!confirm(`确定删除主机 ${id}？`)) return;
    disconnectSession(id);
    await api(`/api/hosts/${encodeURIComponent(id)}`, { method: "DELETE" });
    $("host-dialog").close();
    if (state.activeId === id) state.activeId = null;
    if (state.defaultId === id) {
      state.defaultId = null;
      localStorage.removeItem("ssh-mcp-default-host");
    }
    await refreshHosts();
  });
}

function setupTermResize() {
  const handle = $("term-resize");
  const pane = $("term-pane");
  let startY = 0;
  let startH = 0;
  handle.addEventListener("mousedown", (e) => {
    if (!state.sftpVisible || !state.termVisible) return;
    e.preventDefault();
    startY = e.clientY;
    startH = pane.getBoundingClientRect().height;
    const onMove = (ev) => {
      const dy = startY - ev.clientY;
      const next = Math.max(100, Math.min(window.innerHeight * 0.75, startH + dy));
      pane.style.height = `${next}px`;
      state.termHeightPx = next;
      for (const session of state.sessions.values()) {
        try {
          session.fit.fit();
        } catch {
          /* ignore */
        }
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function setupTransfers() {
  $("btn-upload").addEventListener("click", async () => {
    if (!state.activeId || !state.localSelected || state.localSelected.type !== "file") {
      alert("请先选择一个本地文件");
      return;
    }
    const remotePath =
      (state.remotePath.replace(/\/$/, "") || "") + "/" + state.localSelected.name;
    await api("/api/transfer/upload", {
      method: "POST",
      body: JSON.stringify({
        id: state.activeId,
        localPath: state.localSelected.path,
        remotePath,
      }),
    });
    await refreshRemote();
  });

  $("btn-download").addEventListener("click", async () => {
    if (!state.activeId || !state.remoteSelected || state.remoteSelected.type !== "file") {
      alert("请先选择一个远程文件");
      return;
    }
    const localPath =
      (state.localPath.replace(/\/$/, "") || "") +
      (state.localPath.endsWith("\\") ? "" : "/") +
      state.remoteSelected.name;
    await api("/api/transfer/download", {
      method: "POST",
      body: JSON.stringify({
        id: state.activeId,
        remotePath: state.remoteSelected.path,
        localPath,
      }),
    });
    await refreshLocal();
  });

  ["local-list", "remote-list"].forEach((id) => {
    const el = $(id);
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData("application/x-ssh-mcp");
      if (!raw || !state.activeId) return;
      const payload = JSON.parse(raw);
      if (id === "remote-list" && payload.side === "local" && payload.entry.type === "file") {
        const remotePath =
          (state.remotePath.replace(/\/$/, "") || "") + "/" + payload.entry.name;
        await api("/api/transfer/upload", {
          method: "POST",
          body: JSON.stringify({
            id: state.activeId,
            localPath: payload.entry.path,
            remotePath,
          }),
        });
        await refreshRemote();
      }
      if (id === "local-list" && payload.side === "remote" && payload.entry.type === "file") {
        const localPath =
          (state.localPath.replace(/\/$/, "") || "") + "/" + payload.entry.name;
        await api("/api/transfer/download", {
          method: "POST",
          body: JSON.stringify({
            id: state.activeId,
            remotePath: payload.entry.path,
            localPath,
          }),
        });
        await refreshLocal();
      }
    });
  });
}

function setupNav() {
  $("btn-add").addEventListener("click", () => openHostDialog(null));
  $("btn-refresh").addEventListener("click", () => refreshHosts());
  $("local-go").addEventListener("click", async () => {
    state.localPath = $("local-path").value;
    await refreshLocal();
  });
  $("remote-go").addEventListener("click", async () => {
    state.remotePath = $("remote-path").value;
    await refreshRemote();
  });
  $("local-up").addEventListener("click", async () => {
    const data = await api(`/api/local/list?path=${encodeURIComponent(state.localPath)}`);
    state.localPath = data.parent;
    $("local-path").value = state.localPath;
    await refreshLocal();
  });
  $("remote-up").addEventListener("click", async () => {
    if (!state.activeId) return;
    const data = await api(
      `/api/remote/list?id=${encodeURIComponent(state.activeId)}&path=${encodeURIComponent(state.remotePath)}`
    );
    state.remotePath = data.parent;
    $("remote-path").value = state.remotePath;
    await refreshRemote();
  });
  $("btn-term-clear").addEventListener("click", () => {
    const session = state.activeId ? state.sessions.get(state.activeId) : null;
    if (session) session.term.clear();
  });
  $("btn-close-sftp").addEventListener("click", () => showSftp(false));
  $("btn-close-term").addEventListener("click", () => showTerm(false));
  $("btn-restore-sftp").addEventListener("click", () => showSftp(true));
  $("btn-restore-term").addEventListener("click", () => showTerm(true));
  window.addEventListener("resize", () => {
    for (const session of state.sessions.values()) {
      try {
        session.fit.fit();
      } catch {
        /* ignore */
      }
    }
  });
}

async function main() {
  setupDialog();
  setupTermResize();
  setupTransfers();
  setupNav();
  syncRestoreBar();
  updateTermPlaceholder();
  await refreshHosts();
  await refreshLocal();

  if (state.defaultId && state.hosts.some((h) => h.id === state.defaultId)) {
    await selectHost(state.defaultId, { openFiles: true, openTerm: true });
  }
}

main().catch((err) => {
  console.error(err);
  alert(err.message);
});
