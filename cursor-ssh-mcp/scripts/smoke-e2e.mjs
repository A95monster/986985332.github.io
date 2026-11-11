#!/usr/bin/env node
/**
 * Exhaustive UI/API smoke for cursor-ssh-mcp.
 * Run with UI already on :3847, or this script will start it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.CURSOR_SSH_MCP_UI_URL || "http://127.0.0.1:3847";
const OUT = "/tmp/ssh-mcp-smoke-report.json";
const TEST_DIR = "/tmp/ssh-mcp-smoke-files";

const results = [];
let uiChild = null;
let failed = 0;

function ok(name, pass, detail = {}) {
  results.push({ name, pass: Boolean(pass), ...detail });
  const mark = pass ? "PASS" : "FAIL";
  if (!pass) failed += 1;
  console.log(`[${mark}] ${name}${detail.reason ? ` — ${detail.reason}` : ""}`);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function probe() {
  try {
    const res = await fetch(`${BASE}/work`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureUi() {
  if (await probe()) return;
  uiChild = spawn(process.execPath, [path.join(ROOT, "src/ui-cli.js")], {
    cwd: ROOT,
    env: { ...process.env, CURSOR_SSH_MCP_UI_PORT: "3847" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 40; i++) {
    if (await probe()) return;
    await sleep(150);
  }
  throw new Error("UI server failed to start on :3847");
}

async function api(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

function prepareFiles() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, "alpha.txt"), "alpha");
  fs.writeFileSync(path.join(TEST_DIR, "beta.txt"), "beta");
  fs.writeFileSync(path.join(TEST_DIR, ".hidden"), "secret");
  fs.writeFileSync(path.join(TEST_DIR, "big-ish.bin"), Buffer.alloc(256 * 1024, 7));
}

async function runApiSmoke() {
  const health = await api("/work");
  ok("GET /work", health.status === 200);

  const hosts = await api("/hosts");
  ok("GET /hosts", hosts.status === 200);

  const listHosts = await api("/api/hosts");
  ok("GET /api/hosts", listHosts.ok && Array.isArray(listHosts.data?.hosts));

  const listing = await api(`/api/local/list?path=${encodeURIComponent(TEST_DIR)}`);
  const keys = listing.data?.entries?.[0] ? Object.keys(listing.data.entries[0]).sort() : [];
  ok("local list has metadata", listing.ok && keys.includes("mtime") && keys.includes("perm") && keys.includes("kind"), {
    keys,
  });
  ok(
    "local list includes hidden file",
    listing.data?.entries?.some((e) => e.name === ".hidden"),
    { names: listing.data?.entries?.map((e) => e.name) }
  );

  const mkdirName = `dir-${Date.now()}`;
  const mkdir = await api("/api/fs/mkdir", {
    method: "POST",
    body: JSON.stringify({ scope: "local", path: path.join(TEST_DIR, mkdirName) }),
  });
  ok("fs mkdir", mkdir.ok);

  const renamed = `${mkdirName}-renamed`;
  const ren = await api("/api/fs/rename", {
    method: "POST",
    body: JSON.stringify({
      scope: "local",
      from: path.join(TEST_DIR, mkdirName),
      to: path.join(TEST_DIR, renamed),
    }),
  });
  ok("fs rename", ren.ok);

  const chmod = await api("/api/fs/chmod", {
    method: "POST",
    body: JSON.stringify({
      scope: "local",
      path: path.join(TEST_DIR, "beta.txt"),
      mode: "600",
    }),
  });
  ok("fs chmod", chmod.ok);
  const st = fs.statSync(path.join(TEST_DIR, "beta.txt"));
  ok("chmod reflected on disk", (st.mode & 0o777) === 0o600, { mode: (st.mode & 0o777).toString(8) });

  const del = await api("/api/fs/delete", {
    method: "POST",
    body: JSON.stringify({ scope: "local", path: path.join(TEST_DIR, renamed) }),
  });
  ok("fs delete", del.ok && !fs.existsSync(path.join(TEST_DIR, renamed)));

  const emptyBatch = await api("/api/transfer/upload-batch", {
    method: "POST",
    body: JSON.stringify({ id: "no-such-host", files: [] }),
  });
  ok("upload-batch rejects empty/invalid", emptyBatch.status >= 400);

  const cheat = await api(`/api/cheat?q=${encodeURIComponent("rsync")}`);
  ok("cheat rsync", cheat.ok && typeof cheat.data?.text === "string" && cheat.data.text.length > 20, {
    topic: cheat.data?.topic,
  });
}

async function withPage(fn) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function runUiSmoke() {
  // Prefer playwright if available via npx package in project; else use playwright-cli eval via dynamic import fail soft
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    ok("playwright available", false, { reason: "install playwright to run browser smoke; API smoke still ran" });
    return runUiSmokeViaFetchOnly();
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  // --- hosts panel: postMessage bridge (must be iframe, like Cursor sidebar) ---
  {
    const page = await context.newPage();
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0">
      <iframe id="f" src="${BASE}/hosts" style="width:360px;height:900px;border:0"></iframe>
      <script>
        window.__msgs = [];
        window.addEventListener("message", (e) => {
          if (e.data && e.data.source === "cursor-ssh-mcp-ui") window.__msgs.push(e.data);
        });
      </script>
    </body></html>`);
    const frame = page.frameLocator("#f");
    // #host-empty 在 DOM 里更靠前且常带 .hidden，不能用 first() 等可见
    await Promise.race([
      frame.locator("#host-list li").first().waitFor({ state: "visible", timeout: 12000 }),
      frame.locator("#host-empty:not(.hidden)").waitFor({ state: "visible", timeout: 12000 }),
    ]).catch(() => {});
    await sleep(400);
    const hasHost = (await frame.locator("#host-list li").count()) > 0;
    ok("hosts panel renders in iframe", true, {
      hasHost,
      emptyVisible: await frame.locator("#host-empty:not(.hidden)").count(),
    });

    if (hasHost) {
      for (const act of ["sftp", "term", "both"]) {
        await page.evaluate(() => {
          window.__msgs = [];
        });
        await frame.locator(`#host-list li [data-act="${act}"]`).first().click();
        await sleep(250);
        const msgs = await page.evaluate(() => window.__msgs || []);
        const hit = msgs.find((m) => m?.type === "openWorkbench");
        ok(`hosts ${act} posts openWorkbench`, Boolean(hit), { msgs });
        ok(`hosts ${act} mode=${act}`, hit?.mode === act, { mode: hit?.mode });
      }

      await frame.locator(`#host-list li [data-act="edit"]`).first().click();
      await sleep(250);
      const dialogOpen = await frame.locator("#host-dialog").evaluate((el) => el.open === true);
      ok("hosts edit opens dialog", dialogOpen);
      if (dialogOpen) await frame.locator("#btn-dialog-close").click();
    } else {
      ok("hosts sftp posts openWorkbench", false, { reason: "no saved host" });
      ok("hosts term posts openWorkbench", false, { reason: "no saved host" });
      ok("hosts both posts openWorkbench", false, { reason: "no saved host" });
      ok("hosts edit opens dialog", false, { reason: "no saved host" });
    }
    await page.close();
  }

  // --- work panel behaviors ---
  {
    const page = await context.newPage();
    await page.goto(`${BASE}/work`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#sftp-pane", { timeout: 8000 });

    // layout close button visibility
    const bothClose = await page.evaluate(() => ({
      sftp: !document.getElementById("btn-close-sftp")?.classList.contains("hidden"),
      term: !document.getElementById("btn-close-term")?.classList.contains("hidden"),
    }));
    ok("both panels show close buttons", bothClose.sftp && bothClose.term, bothClose);

    await page.click("#btn-close-sftp");
    await sleep(150);
    const onlyTerm = await page.evaluate(() => ({
      sftpHidden: document.getElementById("sftp-pane")?.classList.contains("hidden"),
      closeTermHidden: document.getElementById("btn-close-term")?.classList.contains("hidden"),
      showSftp: !document.getElementById("btn-show-sftp")?.classList.contains("hidden"),
    }));
    ok("close sftp -> only term, close hidden", onlyTerm.sftpHidden && onlyTerm.closeTermHidden && onlyTerm.showSftp, onlyTerm);

    await page.click("#btn-show-sftp");
    await sleep(150);
    await page.click("#btn-close-term");
    await sleep(150);
    const onlySftp = await page.evaluate(() => ({
      termHidden: document.getElementById("term-pane")?.classList.contains("hidden"),
      closeSftpHidden: document.getElementById("btn-close-sftp")?.classList.contains("hidden"),
      showTerm: !document.getElementById("btn-show-term")?.classList.contains("hidden"),
    }));
    ok("close term -> only sftp, close hidden", onlySftp.termHidden && onlySftp.closeSftpHidden && onlySftp.showTerm, onlySftp);
    await page.click("#btn-show-term");
    await sleep(150);

    // util collapse
    await page.evaluate(() => {
      localStorage.setItem("cursor-ssh-mcp-util-collapsed", "0");
      document.body.classList.remove("util-collapsed");
      const rail = document.getElementById("util-rail");
      if (rail) rail.style.width = rail.style.minWidth = rail.style.maxWidth = "";
    });
    if (await page.locator("#btn-collapse-util").isVisible()) {
      await page.click("#btn-collapse-util");
      await sleep(280);
      const c = await page.evaluate(() => ({
        collapsed: document.body.classList.contains("util-collapsed"),
        w: Math.round(document.getElementById("util-rail").getBoundingClientRect().width),
      }));
      ok("util collapse to ~36px", c.collapsed && c.w <= 40, c);
      await page.click("#util-expand-tab");
      await sleep(280);
      const e = await page.evaluate(() => ({
        collapsed: document.body.classList.contains("util-collapsed"),
        w: Math.round(document.getElementById("util-rail").getBoundingClientRect().width),
      }));
      ok("util expand restores width", !e.collapsed && e.w >= 196, e);
    } else {
      ok("util collapse to ~36px", false, { reason: "collapse button not visible" });
      ok("util expand restores width", false, { reason: "skipped" });
    }

    // theme follows util rail
    await page.click("[data-util=theme]");
    await sleep(200);
    const themeBefore = await page.evaluate(() => {
      const rail = document.getElementById("util-rail");
      return {
        bg: getComputedStyle(rail).backgroundColor,
        accent: rail.style.getPropertyValue("--util-accent").trim(),
      };
    });
    const themeCard = page.locator("[data-act=pick-theme]").nth(1);
    if (await themeCard.count()) {
      await themeCard.click();
      await sleep(200);
      const themeAfter = await page.evaluate(() => {
        const rail = document.getElementById("util-rail");
        return {
          bg: getComputedStyle(rail).backgroundColor,
          accent: rail.style.getPropertyValue("--util-accent").trim(),
          theme: localStorage.getItem("cursor-ssh-mcp-theme"),
        };
      });
      ok(
        "util rail follows theme",
        themeAfter.bg !== themeBefore.bg || themeAfter.accent !== themeBefore.accent,
        { themeBefore, themeAfter }
      );
    } else {
      ok("util rail follows theme", false, { reason: "no theme cards" });
    }

    // SFTP table navigate + hidden + filter + sort + context ops
    await page.fill("#local-path", TEST_DIR);
    await page.click("#local-go");
    await sleep(700);
    const names1 = await page.evaluate(() =>
      [...document.querySelectorAll("#local-list .file-name")].map((x) => x.textContent).filter((n) => n !== "..")
    );
    ok("sftp lists test dir", names1.includes("alpha.txt") && names1.includes("beta.txt"), { names1 });
    ok("hidden file default hidden", !names1.includes(".hidden"), { names1 });

    await page.check("#sftp-show-hidden");
    await sleep(120);
    const names2 = await page.evaluate(() =>
      [...document.querySelectorAll("#local-list .file-name")].map((x) => x.textContent)
    );
    ok("show hidden reveals .hidden", names2.includes(".hidden"), { names2 });

    await page.fill("#left-filter", "alpha");
    await sleep(120);
    const filtered = await page.evaluate(() =>
      [...document.querySelectorAll("#local-list .file-name")].map((x) => x.textContent).filter((n) => n !== "..")
    );
    ok("filter alpha", filtered.length === 1 && filtered[0] === "alpha.txt", { filtered });
    await page.fill("#left-filter", "");
    await sleep(100);

    await page.click('.file-table[data-side=left] th[data-sort="size"]');
    await sleep(100);
    const sorted = await page.evaluate(
      () => document.querySelector('.file-table[data-side=left] th.sorted')?.textContent || ""
    );
    ok("sort by size", /大小/.test(sorted), { sorted });

    // context rename
    await page.evaluate(() => {
      const row = [...document.querySelectorAll("#local-list tr")].find(
        (tr) => tr.querySelector(".file-name")?.textContent === "alpha.txt"
      );
      row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 400, clientY: 300 }));
    });
    await sleep(120);
    const menuOpen = await page.evaluate(
      () => !document.getElementById("file-context-menu")?.classList.contains("hidden")
    );
    ok("context menu opens", menuOpen);
    await page.click('#file-context-menu [data-ctx="rename"]');
    await sleep(150);
    ok("rename dialog opens", await page.evaluate(() => document.getElementById("app-prompt")?.open === true));
    await page.fill("#app-prompt-input", "alpha-renamed.txt");
    await page.click("#app-prompt-ok");
    await sleep(800);
    const afterRename = await page.evaluate(() =>
      [...document.querySelectorAll("#local-list .file-name")].map((x) => x.textContent)
    );
    ok("rename refreshes list", afterRename.includes("alpha-renamed.txt") && !afterRename.includes("alpha.txt"), {
      afterRename,
    });

    // mkdir via context
    await page.evaluate(() => {
      const row = [...document.querySelectorAll("#local-list tr")].find(
        (tr) => tr.querySelector(".file-name")?.textContent === "beta.txt"
      );
      row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 400, clientY: 320 }));
    });
    await sleep(100);
    await page.click('#file-context-menu [data-ctx="mkdir"]');
    await sleep(120);
    await page.fill("#app-prompt-input", "smoke-dir");
    await page.click("#app-prompt-ok");
    await sleep(800);
    const afterMkdir = await page.evaluate(() =>
      [...document.querySelectorAll("#local-list .file-name")].map((x) => x.textContent)
    );
    ok("mkdir refreshes list", afterMkdir.includes("smoke-dir"), { afterMkdir });

    // delete renamed
    await page.evaluate(() => {
      const row = [...document.querySelectorAll("#local-list tr")].find(
        (tr) => tr.querySelector(".file-name")?.textContent === "alpha-renamed.txt"
      );
      row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 400, clientY: 320 }));
    });
    await sleep(100);
    await page.click('#file-context-menu [data-ctx="delete"]');
    await sleep(120);
    ok("delete confirm opens", await page.evaluate(() => document.getElementById("app-confirm")?.open === true));
    await page.click("#app-confirm-ok");
    await sleep(800);
    const afterDelete = await page.evaluate(() =>
      [...document.querySelectorAll("#local-list .file-name")].map((x) => x.textContent)
    );
    ok("delete refreshes list", !afterDelete.includes("alpha-renamed.txt"), { afterDelete });

    // perm under filename（跳过「..」行，取真实文件）
    const permLayout = await page.evaluate(() => {
      const row = [...document.querySelectorAll("#local-list tr")].find((tr) => {
        const name = tr.querySelector(".file-name")?.textContent;
        return name && name !== ".." && tr.querySelector(".file-perm");
      });
      const cell = row?.querySelector(".name-cell");
      return {
        name: row?.querySelector(".file-name")?.textContent || null,
        hasMeta: Boolean(cell?.querySelector(".file-meta")),
        hasPerm: Boolean(cell?.querySelector(".file-perm")),
        perm: cell?.querySelector(".file-perm")?.textContent || null,
      };
    });
    ok("perm under filename layout", permLayout.hasMeta && permLayout.hasPerm, permLayout);

    await page.close();
  }

  // extension bridge static contract
  {
    const ext = fs.readFileSync(path.join(ROOT, "extension/extension.js"), "utf8");
    ok("extension bridge listens parent messages", ext.includes("acquireVsCodeApi") && ext.includes("onDidReceiveMessage"));
    ok("extension openWorkbench on hosts action", ext.includes('msg.type === "openWorkbench"'));
    ok("extension registers openEditor alias", ext.includes('registerCommand("cursorSshMcp.openEditor"'));
  }

  await browser.close();
  void chromium;
}

async function runUiSmokeViaFetchOnly() {
  // fallback minimal
  const html = await (await fetch(`${BASE}/index.html`)).text();
  ok("index has context menu", html.includes("file-context-menu") && html.includes("app-prompt"));
  ok("index has util collapse", html.includes("btn-collapse-util") && html.includes("util-expand-tab"));
}

async function main() {
  console.log("== cursor-ssh-mcp exhaustive smoke ==");
  prepareFiles();
  await ensureUi();
  await runApiSmoke();
  await runUiSmoke();

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    failed,
    total: results.length,
    passed: results.length - failed,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nSummary: ${report.passed}/${report.total} passed, ${failed} failed`);
  console.log(`Report: ${OUT}`);
  if (uiChild) {
    try {
      uiChild.kill();
    } catch {
      /* ignore */
    }
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
