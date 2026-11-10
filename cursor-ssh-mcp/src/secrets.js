import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./hosts.js";

function secretsPath() {
  return path.join(dataDir(), "secrets.json");
}

function ensure() {
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = secretsPath();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "{}\n", { encoding: "utf8", mode: 0o600 });
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows may ignore */
  }
}

export function loadSecrets() {
  ensure();
  return JSON.parse(fs.readFileSync(secretsPath(), "utf8") || "{}");
}

export function saveSecrets(map) {
  ensure();
  const tmp = `${secretsPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, secretsPath());
  try {
    fs.chmodSync(secretsPath(), 0o600);
  } catch {
    /* ignore */
  }
}

export function setHostSecret(hostId, { password, passphrase } = {}) {
  const map = loadSecrets();
  const cur = map[hostId] || {};
  if (password !== undefined) {
    if (password === null || password === "") delete cur.password;
    else cur.password = String(password);
  }
  if (passphrase !== undefined) {
    if (passphrase === null || passphrase === "") delete cur.passphrase;
    else cur.passphrase = String(passphrase);
  }
  if (!cur.password && !cur.passphrase) delete map[hostId];
  else map[hostId] = cur;
  saveSecrets(map);
}

export function getHostSecret(hostId) {
  return loadSecrets()[hostId] || {};
}

export function deleteHostSecret(hostId) {
  const map = loadSecrets();
  if (map[hostId]) {
    delete map[hostId];
    saveSecrets(map);
  }
}
