"""Generate Trace's existing mark as Windows icons; embed and verify PE resources.

Uses only Python's standard library and the Windows resource API. The source
Electron binary is never edited: --embed accepts a prepared Trace.exe copy.
"""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import zlib

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "desktop" / "assets"
SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)
MARK_PATH = "M4 4h20v20H4zM4 14h20M14 4v20M4 24 24 4"
INK = (25, 44, 100)


def chunk(kind, content):
    return struct.pack(">I", len(content)) + kind + content + struct.pack(">I", zlib.crc32(kind + content))


def render(size):
    """Supersample the SVG's square, grid and diagonal onto a white Paper tile."""
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            covered = ink = 0
            for sy in range(4):
                py = (y + (sy + 0.5) / 4) * 28 / size
                for sx in range(4):
                    px = (x + (sx + 0.5) / 4) * 28 / size
                    # A small white tile retains contrast on dark Windows surfaces.
                    dx = max(4 - px, 0, px - 24)
                    dy = max(4 - py, 0, py - 24)
                    if dx * dx + dy * dy > 9:
                        continue
                    covered += 1
                    border = (3.35 <= px <= 24.65 and 3.35 <= py <= 24.65
                              and not (4.65 < px < 23.35 and 4.65 < py < 23.35))
                    horizontal = 4 <= px <= 24 and abs(py - 14) <= 0.65
                    vertical = 4 <= py <= 24 and abs(px - 14) <= 0.65
                    diagonal = 4 <= px <= 24 and 4 <= py <= 24 and abs(px + py - 28) <= 0.65 * math.sqrt(2)
                    ink += border or horizontal or vertical or diagonal
            rows.extend(round((channel * ink + 255 * (covered - ink)) / covered) if covered else 0 for channel in INK)
            rows.append(round(255 * covered / 16))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def generate():
    svg = (ROOT / "public" / "trace-mark.svg").read_text(encoding="utf-8")
    assert MARK_PATH in svg and '#192c64' in svg, "Icon geometry must match the existing Trace mark"
    ASSETS.mkdir(parents=True, exist_ok=True)
    frames = [(size, render(size)) for size in SIZES]
    offset = 6 + 16 * len(frames)
    directory = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
    data = bytearray()
    for size, png in frames:
        directory.extend(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(png), offset))
        data.extend(png)
        offset += len(png)
    (ASSETS / "trace.ico").write_bytes(directory + data)
    (ASSETS / "trace.png").write_bytes(frames[-1][1])
    (ASSETS / "trace-tray.png").write_bytes(dict(frames)[32])
    return frames


def icon_frames():
    icon = (ASSETS / "trace.ico").read_bytes()
    reserved, kind, count = struct.unpack_from("<HHH", icon)
    assert (reserved, kind, count) == (0, 1, len(SIZES))
    entries = []
    for n in range(count):
        width, height, colors, zero, planes, depth, length, offset = struct.unpack_from("<BBBBHHII", icon, 6 + n * 16)
        png = icon[offset:offset + length]
        assert png.startswith(b"\x89PNG\r\n\x1a\n")
        assert struct.unpack_from(">II", png, 16) == (SIZES[n], SIZES[n])
        entries.append((struct.pack("<BBBBHHI", width, height, colors, zero, planes, depth, length), png))
    return entries


class Resources:
    def __init__(self, path):
        if sys.platform != "win32":
            raise RuntimeError("Windows executable resources must be updated on Windows")
        self.path = str(path)
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
        self.api.LoadLibraryExW.restype = wintypes.HMODULE
        self.api.FreeLibrary.argtypes = [wintypes.HMODULE]
        self.api.FindResourceExW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD]
        self.api.FindResourceExW.restype = wintypes.HANDLE
        self.api.SizeofResource.argtypes = [wintypes.HMODULE, wintypes.HANDLE]
        self.api.SizeofResource.restype = wintypes.DWORD
        self.api.LoadResource.argtypes = [wintypes.HMODULE, wintypes.HANDLE]
        self.api.LoadResource.restype = wintypes.HANDLE
        self.api.LockResource.argtypes = [wintypes.HANDLE]
        self.api.LockResource.restype = ctypes.c_void_p
        self.api.BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
        self.api.BeginUpdateResourceW.restype = wintypes.HANDLE
        self.api.UpdateResourceW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD, ctypes.c_void_p, wintypes.DWORD]
        self.api.UpdateResourceW.restype = wintypes.BOOL
        self.api.EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]
        self.api.EndUpdateResourceW.restype = wintypes.BOOL
        self.strings = []

    def name(self, value):
        if isinstance(value, int):
            return value
        string = ctypes.create_unicode_buffer(value)
        self.strings.append(string)
        return ctypes.cast(string, ctypes.c_void_p)

    def read(self, types):
        module = self.api.LoadLibraryExW(self.path, None, 0x22)
        if not module:
            raise ctypes.WinError(ctypes.get_last_error())
        records = {}
        name_callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, wintypes.LPARAM)
        lang_callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD, wintypes.LPARAM)
        self.api.EnumResourceNamesW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, name_callback, wintypes.LPARAM]
        self.api.EnumResourceLanguagesW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, lang_callback, wintypes.LPARAM]
        try:
            for resource_type in types:
                @name_callback
                def found_name(handle, kind, name, _param):
                    resource_name = name if name <= 65535 else ctypes.wstring_at(name)
                    @lang_callback
                    def found_language(handle, kind, name, language, _param):
                        resource = self.api.FindResourceExW(handle, kind, name, language)
                        size = self.api.SizeofResource(handle, resource)
                        data = self.api.LockResource(self.api.LoadResource(handle, resource))
                        records[(resource_type, resource_name, language)] = ctypes.string_at(data, size)
                        return True
                    self.api.EnumResourceLanguagesW(handle, kind, name, found_language, 0)
                    return True
                self.api.EnumResourceNamesW(module, resource_type, found_name, 0)
        finally:
            self.api.FreeLibrary(module)
        return records

    def update(self, values):
        handle = self.api.BeginUpdateResourceW(self.path, False)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            for (kind, name, language), data in values.items():
                buffer = ctypes.create_string_buffer(data) if data is not None else None
                if not self.api.UpdateResourceW(handle, kind, self.name(name), language, buffer, len(data) if data is not None else 0):
                    raise ctypes.WinError(ctypes.get_last_error())
        except BaseException:
            self.api.EndUpdateResourceW(handle, True)
            raise
        if not self.api.EndUpdateResourceW(handle, False):
            raise ctypes.WinError(ctypes.get_last_error())


def embed(executable):
    path = Path(executable).resolve()
    artifacts = (ROOT / "artifacts").resolve()
    assert path.is_relative_to(artifacts) and path.name == "Trace.exe", "Only prepared Trace.exe copies inside artifacts may be edited"
    resources = Resources(path)
    before = resources.read((3, 14, 16))
    groups = [key for key in before if key[0] == 14] or [(14, 1, 1033)]
    frames = icon_frames()
    group = struct.pack("<HHH", 0, 1, len(frames)) + b"".join(entry + struct.pack("<H", n + 1) for n, (entry, _) in enumerate(frames))
    updates = {key: None for key in before if key[0] in (3, 14)}
    for key in groups:
        updates[key] = group
        for n, (_, png) in enumerate(frames):
            updates[(3, n + 1, key[2])] = png
    resources.update(updates)
    after = resources.read((3, 14, 16))
    for key, content in before.items():
        if key[0] == 16:
            assert after[key] == content, "Existing executable metadata was changed"
    for key in groups:
        assert after[key] == group, "Trace icon group was not embedded"
        for n, (_, png) in enumerate(frames):
            assert after[(3, n + 1, key[2])] == png, "Embedded icon frame differs from the Trace asset"
    print(json.dumps({"executable": str(path), "iconGroups": len(groups), "sizes": list(SIZES), "iconSha256": hashlib.sha256((ASSETS / "trace.ico").read_bytes()).hexdigest(), "verified": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--embed", type=Path)
    args = parser.parse_args()
    if args.embed:
        embed(args.embed)
    else:
        generate()
        icon_frames()
        print("Generated Trace ICO, window PNG and tray PNG from the existing brand mark.")
