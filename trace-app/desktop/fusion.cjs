const { join } = require("node:path");
const { homedir } = require("node:os");
const { mkdir, readFile, copyFile, cp, access } = require("node:fs/promises");
const { bridgeDir } = require("./bridge.cjs");
function installPath() {
  if (process.platform === "win32")
    return join(
      process.env.APPDATA || join(homedir(), "AppData/Roaming"),
      "Autodesk/Autodesk Fusion 360/API/AddIns/DesignRecorderAgent",
    );
  if (process.platform === "darwin")
    return join(
      homedir(),
      "Library/Application Support/Autodesk/Autodesk Fusion/API/AddIns/DesignRecorderAgent",
    );
  throw new Error("Fusion installation is supported on Windows and macOS.");
}
async function fusionStatus() {
  let version = null,
    delivery = null;
  try {
    version = JSON.parse(
      await readFile(
        join(installPath(), "DesignRecorderAgent.manifest"),
        "utf8",
      ),
    ).version;
  } catch {}
  try {
    delivery = JSON.parse(
      await readFile(join(bridgeDir(), "fusion-status.json"), "utf8"),
    );
  } catch {}
  return { version, delivery };
}
async function installFusion(
  source,
  target = installPath(),
  backupRoot = join(bridgeDir(), "addin-backups"),
) {
  // Validate the complete bundle before touching a working installation.
  const files = [
    "DesignRecorderAgent.py",
    "DesignRecorderAgent.manifest",
    "trace_transport.py",
    "AddInIcon.svg",
    "DesignRecorderAgent.config.json",
  ];
  for (const name of files) await readFile(join(source, name));
  let exists = false;
  try {
    await access(target);
    exists = true;
  } catch {}
  let backup = null;
  if (exists) {
    backup = join(backupRoot, new Date().toISOString().replace(/[:.]/g, "-"));
    await mkdir(backup, { recursive: true });
    await cp(target, backup, { recursive: true });
  }
  await mkdir(target, { recursive: true });
  // Preserve the user's configuration and any unrelated resources. New code
  // defaults to discovery even when a legacy uploadUrl is still present.
  for (const name of [
    "DesignRecorderAgent.py",
    "DesignRecorderAgent.manifest",
    "trace_transport.py",
    "AddInIcon.svg",
  ])
    await copyFile(join(source, name), join(target, name));
  try {
    await access(join(target, "DesignRecorderAgent.config.json"));
  } catch {
    await copyFile(
      join(source, "DesignRecorderAgent.config.json"),
      join(target, "DesignRecorderAgent.config.json"),
    );
  }
  return { ok: true, backup, restartRequired: true };
}
module.exports = { installFusion, fusionStatus, installPath };
