import {
  dataDir,
  hostsPath,
  listHostsPublic,
  removeHost,
  upsertHost,
} from "../src/hosts.js";

const id = `smoke-${Date.now()}`;
upsertHost({
  id,
  name: "Smoke Host",
  host: "127.0.0.1",
  port: 22,
  username: "smoke",
  privateKeyPath: "~/.ssh/id_ed25519",
});
const listed = listHostsPublic().some((h) => h.id === id);
removeHost(id);

if (!listed) {
  console.error("smoke failed: host not listed");
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dataDir: dataDir(),
      hostsFile: hostsPath(),
    },
    null,
    2
  )
);
