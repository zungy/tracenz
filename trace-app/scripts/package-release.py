"""Archive a prepared portable build and verify its contents before delivery."""
import hashlib
import json
from pathlib import Path
import re
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
build = root / "artifacts" / f"Trace-v{version}-win32-x64"
archive = root / "artifacts" / f"Trace-desktop-v{version}-Windows-x64.zip"
assert (build / "Trace.exe").is_file(), "Run npm run package:windows first"
application = build / "resources" / "app"
assert json.loads((application / "package.json").read_text(encoding="utf-8"))["version"] == version
for file in application.rglob("*"):
    if not file.is_file():
        continue
    assert file.name != ".env" and ".data" not in file.parts and "setup-proof" not in file.parts, file
    assert not re.search(rb"sk-proj-[A-Za-z0-9_-]{30,}", file.read_bytes()), f"Potential credential: {file.name}"
assert not (application / "scripts").exists(), "QA harness must not ship in the desktop"
with ZipFile(archive, "w", compression=ZIP_DEFLATED, compresslevel=6) as zipped:
    for file in sorted(build.rglob("*")):
        if file.is_file():
            zipped.write(file, file.relative_to(build.parent).as_posix())
with ZipFile(archive) as zipped:
    assert zipped.testzip() is None
    count = len(zipped.namelist())
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(archive.with_suffix(".zip.sha256")).write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
print(json.dumps({"archive": str(archive), "files": count, "bytes": archive.stat().st_size, "sha256": digest}))
