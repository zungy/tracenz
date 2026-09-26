import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import bridge from "../desktop/bridge.cjs";
import { hash } from "./domain.js";
const owner = "00000000-0000-4000-8000-000000000001";
export async function publishBridge(config, store, port) {
  const directory = bridge.bridgeDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const credentialFile = join(config.dataDir, "fusion-credential.json");
  let saved;
  try {
    saved = JSON.parse(await readFile(credentialFile, "utf8"));
  } catch {}
  if (!saved?.token || (await store.tokenOwner(hash(saved.token))) !== owner) {
    saved = { token: `trc_${randomBytes(32).toString("hex")}` };
    await store.createToken(owner, {
      id: randomUUID(),
      name: "Automatic Fusion connection",
      token_hash: hash(saved.token),
      prefix: saved.token.slice(0, 12),
      created_at: new Date().toISOString(),
    });
    await bridge.atomicJSON(credentialFile, saved);
  }
  const record = {
    version: 1,
    url: `http://127.0.0.1:${port}`,
    uploadToken: saved.token,
    instanceId: config.bridgeInstance,
  };
  const path = join(directory, "connection.json");
  await bridge.atomicJSON(path, record);
  return async () => {
    try {
      const current = JSON.parse(await readFile(path, "utf8"));
      if (current.instanceId === record.instanceId) await unlink(path);
    } catch {}
  };
}
