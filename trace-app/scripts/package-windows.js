import {
  mkdir,
  readdir,
  copyFile,
  cp,
  access,
  readFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const target = resolve(`artifacts/Trace-v${version}-win32-x64`),
  runtime = resolve("node_modules/electron/dist");
await access(join(runtime, "electron.exe"));
await mkdir(target, { recursive: true });
for (const item of await readdir(runtime, { withFileTypes: true })) {
  const destination = join(
    target,
    item.name === "electron.exe" ? "Trace.exe" : item.name,
  );
  if (item.isDirectory())
    await cp(join(runtime, item.name), destination, { recursive: true });
  else await copyFile(join(runtime, item.name), destination);
}
const application = join(target, "resources/app");
await mkdir(application, { recursive: true });
for (const name of ["desktop", "public", "server", "supabase", "fusion"])
  await cp(resolve(name), join(application, name), {
    recursive: true,
    filter: (source) =>
      !source.includes("__pycache__") &&
      !source.endsWith(".pyc") &&
      !source.includes("setup-proof"),
  });
for (const name of ["package.json", ".env.example"])
  await copyFile(resolve(name), join(application, name));
await copyFile(resolve("docs/USER-GUIDE.md"), join(application, "README.md"));
// Windows Explorer reads the PE icon resources; BrowserWindow.icon alone does
// not replace Electron's icon on the downloadable executable.
execFileSync(
  process.env.PYTHON || "python",
  [resolve("scripts/brand-icons.py"), "--embed", join(target, "Trace.exe")],
  { stdio: "inherit", windowsHide: true },
);
console.log(`Portable desktop build: ${join(target, "Trace.exe")}`);
console.log(
  "Keep the entire folder together. The build is unsigned; no installer or auto-update is configured.",
);
