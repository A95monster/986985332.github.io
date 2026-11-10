/* global Terminal, FitAddon */
const state = {
  hosts: [],
  activeId: null,
  localPath: "/",
  remotePath: ".",
  localSelected: null,
  remoteSelected: null,
  term: null,
  fit: null,
  ws: null,
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

function renderHosts() {
  const ul = $("host-list");
  ul.innerHTML = "";
  state.hosts.forEach((h) => {
    const li = document.createElement("li");
    li.dataset.id = h.id;
    if (h.id === state.activeId) li.classList.add("active");
    li.innerHTML = `<div>${escapeHtml(h.name || h.id)}</div><div class="meta">${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port || 22}</div>`;
    li.addEventListener("click", () => selectHost(h.id, false));
    li.addEventListener("dblclick", () => selectHost(h.id, true));
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openHostDialog(h);
    });
    ul.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

async function selectHost(id, openTerminal) {
  state.activeId = id;
  renderHosts();
  const host = state.hosts.find((h) => h.id === id);
  $("session-info").textContent = JSON.stringify(host, null, 2);
  $("term-title").textContent = host ? `Terminal — ${host.name || host.id}` : "Terminal";
  try {
    const listing = await api(`/api/remote/list?id=${encodeURIComponent(id)}&path=${encodeURIComponent(state.remotePath || ".")}`);
    state.remotePath = listing.path;
    $("remote-path").value = listing.path;
    renderFileList($("remote-list"), listing.entries, "remote");
  } catch (err) {
    $("remote-list").innerHTML = `<li>${escapeHtml(err.message)}</li>`;
  }
  if (openTerminal) connectTerminal(id);
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

function ensureTerminal() {
  if (state.term) return;
  state.term = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
    theme: { background: "#1e1e1e", foreground: "#dddddd" },
  });
  state.fit = new FitAddon.FitAddon();
  state.term.loadAddon(state.fit);
  state.term.open($("terminal"));
  state.fit.fit();
  window.addEventListener("resize", () => state.fit && state.fit.fit());
}

function connectTerminal(id) {
  ensureTerminal();
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      /* ignore */
    }
  }
  state.term.clear();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/shell?id=${encodeURIComponent(id)}`);
  state.ws = ws;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "data") state.term.write(msg.data);
    if (msg.type === "error") state.term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
    if (msg.type === "ready") {
      state.fit.fit();
      ws.send(JSON.stringify({ type: "resize", cols: state.term.cols, rows: state.term.rows }));
    }
  };
  state.term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
  });
  state.term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  });
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
  $("dialog-title").textContent = host ? "Edit host" : "Add host";
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
    if (!confirm(`Delete host ${id}?`)) return;
    await api(`/api/hosts/${encodeURIComponent(id)}`, { method: "DELETE" });
    $("host-dialog").close();
    if (state.activeId === id) state.activeId = null;
    await refreshHosts();
  });
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $(`tab-${btn.dataset.tab}`).classList.add("active");
      if (btn.dataset.tab === "sftp") {
        setTimeout(() => state.fit && state.fit.fit(), 0);
      }
    });
  });
}

function setupTermResize() {
  const handle = $("term-resize");
  const pane = $("term-pane");
  let startY = 0;
  let startH = 0;
  handle.addEventListener("mousedown", (e) => {
    startY = e.clientY;
    startH = pane.getBoundingClientRect().height;
    const onMove = (ev) => {
      const dy = startY - ev.clientY;
      const next = Math.max(100, Math.min(window.innerHeight * 0.7, startH + dy));
      pane.style.height = `${next}px`;
      state.fit && state.fit.fit();
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
      alert("Select a local file first");
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
      alert("Select a remote file first");
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

  // Drag-and-drop between panes
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
  $("btn-term-clear").addEventListener("click", () => state.term && state.term.clear());
}

async function main() {
  setupDialog();
  setupTabs();
  setupTermResize();
  setupTransfers();
  setupNav();
  ensureTerminal();
  await refreshHosts();
  await refreshLocal();
}

main().catch((err) => {
  console.error(err);
  alert(err.message);
});
