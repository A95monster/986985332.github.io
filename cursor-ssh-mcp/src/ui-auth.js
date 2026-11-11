import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./hosts.js";

const TOKEN_FILE = "ui-token";
const COOKIE_NAME = "cursor_ssh_mcp_token";

export function tokenFilePath() {
  return path.join(dataDir(), TOKEN_FILE);
}

export function getOrCreateUiToken() {
  const fromEnv = process.env.CURSOR_SSH_MCP_UI_TOKEN;
  if (fromEnv && String(fromEnv).trim()) {
    return String(fromEnv).trim();
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = tokenFilePath();
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (existing.length >= 24) return existing;
    }
  } catch {
    /* recreate */
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  return token;
}

export function cookieName() {
  return COOKIE_NAME;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header)
    .split(";")
    .forEach((part) => {
      const idx = part.indexOf("=");
      if (idx < 0) return;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    });
  return out;
}

export function extractBearer(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const cookies = parseCookies(req.headers?.cookie);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const q = url.searchParams.get("token");
    if (q) return q.trim();
  } catch {
    /* ignore */
  }
  return "";
}

export function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

export function isAuthorized(req, expectedToken) {
  if (!expectedToken) return false;
  const got = extractBearer(req);
  return timingSafeEqualStr(got, expectedToken);
}

/** 仅允许本机 Host，降低 DNS rebinding 风险 */
export function isAllowedHostHeader(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).split(",")[0].trim().toLowerCase();
  const name = host.replace(/^\[|\]$/g, "").split(":")[0];
  return (
    name === "127.0.0.1" ||
    name === "localhost" ||
    name === "::1" ||
    name === "0.0.0.0"
  );
}

export function authCookieHeader(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}

export function setAuthCookie(res, token) {
  res.setHeader("Set-Cookie", authCookieHeader(token));
}
