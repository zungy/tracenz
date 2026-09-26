import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { zip } from "../server/zip.js";
const entries = [];
async function add(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (
      entry.name === "__pycache__" ||
      entry.name === "setup-proof" ||
      entry.name.endsWith(".pyc")
    )
      continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) await add(child);
    else
      entries.push({
        name: "trace-app/" + child.replaceAll("\\", "/"),
        bytes: await readFile(child),
      });
  }
}
for (const folder of [
  "desktop",
  "public",
  "server",
  "supabase",
  "scripts",
  "test",
  "docs",
  "fusion",
])
  await add(folder);
for (const name of [
  "package.json",
  "package-lock.json",
  ".env.example",
  ".gitignore",
  "README.md",
  "Launch Trace.cmd",
  "Dockerfile",
  ".dockerignore",
])
  entries.push({ name: "trace-app/" + name, bytes: await readFile(name) });
for (const entry of entries)
  if (/sk-proj-[A-Za-z0-9_-]{30,}/.test(entry.bytes.toString("utf8")))
    throw new Error(`Potential credential in ${entry.name}`);
await mkdir("artifacts", { recursive: true });
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const archive = zip(entries);
await writeFile(`artifacts/Trace-source-v${version}.zip`, archive);
await writeFile("artifacts/Trace-source.zip", archive);
console.log(
  `Source archive: ${entries.length} files. Excludes credentials, personal history and the original copied add-in.`,
);
