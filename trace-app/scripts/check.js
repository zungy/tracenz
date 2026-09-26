import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
let failed = false;
for (const folder of ["server", "public", "desktop", "scripts", "test"]) {
  for (const name of readdirSync(folder).filter((name) =>
    /\.(?:js|cjs)$/.test(name),
  )) {
    const result = spawnSync(
      process.execPath,
      ["--check", join(folder, name)],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      failed = true;
      console.error(result.stderr);
    }
  }
}
if (failed) process.exit(1);
else console.log("All JavaScript syntax checks passed.");
