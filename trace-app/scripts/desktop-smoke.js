import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  data = resolve(".data/desktop-smoke");
mkdirSync(data, { recursive: true });
const environment = {
  ...process.env,
  TRACE_SMOKE: "1",
  TRACE_DESKTOP_DATA: data,
  TRACE_API_URL: "http://127.0.0.1:4318",
};
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), ["."], {
  env: environment,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (bytes) => {
  output += bytes;
  process.stdout.write(bytes);
});
child.stderr.on("data", (bytes) => process.stderr.write(bytes));
const timeout = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 30_000);
child.on("exit", (code) => {
  clearTimeout(timeout);
  if (code || !output.includes("TRACE_DESKTOP_SMOKE")) process.exitCode = 1;
});
