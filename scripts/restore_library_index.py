#!/usr/bin/env python3
"""Rebuild tracks rows from the library files. EMERGENCY RECOVERY.

The library index was destroyed by a bulk delete run against an unverified
existence probe. The audio was never touched; the rows were. This reconstructs
them from what is on disk and writes a TSV, which is then inserted separately.

Recovered from disk: artist, album, track number, title, format, bit depth,
sample rate, duration, size, sha256, cover path, sidecar presence.
NOT recoverable from disk: ISRC, year, genre, provider link (left null for the
metadata reindex to fill).

Writes the TSV only after self-checks:
  - every emitted file_path is verified to exist
  - provider_track_id is never a URL and is unique
  - the row count equals the audio file count
Exit non-zero if any check fails, so a broken run cannot be mistaken for a good one.
"""
import argparse
import hashlib
import os
import struct
import sys

AUDIO = (".flac", ".mp3", ".wav", ".aiff", ".aif", ".m4a", ".ogg", ".opus")


def probe_flac(path):
    try:
        with open(path, "rb") as f:
            head = f.read(42)
    except OSError:
        return (None, None, None)
    if len(head) < 42 or head[0:4] != b"fLaC":
        return (None, None, None)
    p = 4
    while p + 4 <= len(head):
        typ = head[p] & 0x7F
        ln = ((head[p + 1] & 0x7F) << 16) | (head[p + 2] << 8) | head[p + 3]
        if typ == 0:
            b = head[p + 4:p + 4 + 18]
            if len(b) < 14:
                return (None, None, None)
            rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4)
            depth = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1
            total = ((b[13] & 0x0F) * 4294967296 + b[14] * 16777216 + b[15] * 65536
                     + b[16] * 256 + b[17])
            dur = round(total / rate) if rate else None
            return (depth or None, rate or None, dur)
        p += 4 + ln
        if (head[p - 4 - ln] & 0x80):
            break
    return (None, None, None)


def probe_wav(path):
    try:
        with open(path, "rb") as f:
            head = f.read(64)
    except OSError:
        return (None, None, None)
    i = head.find(b"fmt ")
    if i < 0 or i + 24 > len(head):
        return (None, None, None)
    try:
        return (struct.unpack_from("<H", head, i + 14)[0],
                struct.unpack_from("<I", head, i + 4)[0], None)
    except struct.error:
        return (None, None, None)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def split_stem(stem):
    import re
    m = re.match(r"^(\d{1,3})\s*[-–—]\s*(.+)$", stem)
    if not m:
        return (None, stem.strip() or "Unknown Title")
    return (int(m.group(1)), m.group(2).strip() or "Unknown Title")


def walk(root):
    for dirpath, _d, filenames in os.walk(root):
        for fn in filenames:
            if fn.lower().endswith(AUDIO):
                yield os.path.join(dirpath, fn)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    files = sorted(walk(args.root))
    print(f"found {len(files)} audio file(s) under {args.root}", flush=True)

    rows = []
    ids = set()
    problems = []
    for abs_path in files:
        rel = os.path.relpath(abs_path, args.root)
        parts = rel.split(os.sep)
        ext = os.path.splitext(abs_path)[1].lower()
        stem = rel[: len(rel) - len(ext)]
        sp = stem.split(os.sep)

        artist = "Unknown Artist"
        album = ""
        if len(sp) >= 3:
            artist = sp[-3]
            album = sp[-2]
        elif len(sp) == 2:
            artist = sp[0]
        track_no, title = split_stem(sp[-1])

        size = os.path.getsize(abs_path)
        if ext == ".flac":
            depth, rate, dur = probe_flac(abs_path)
        elif ext in (".wav", ".aiff", ".aif"):
            depth, rate, dur = probe_wav(abs_path)
        else:
            depth = rate = dur = None

        digest = sha256(abs_path)
        ptid = "local:" + digest[:32]
        if "://" in ptid:
            problems.append(f"id looks like a URL: {ptid}")
        if ptid in ids:
            # Two paths with byte-identical audio. The hash cannot separate them, so
            # mix in the path. Still content-first, so a re-scan is stable, and still
            # not a URL -- the column is half a unique key and must never hold one.
            import hashlib as _h
            ptid = "local:" + digest[:24] + _h.sha1(rel.encode()).hexdigest()[:8]
        if ptid in ids:
            problems.append(f"STILL duplicate id {ptid} ({abs_path})")
        ids.add(ptid)

        d = os.path.dirname(abs_path)
        cover = ""
        for c in ("cover.jpg", "cover.png", "folder.jpg", "cover.jpeg"):
            if os.path.exists(os.path.join(d, c)):
                cover = os.path.join(d, c)
                break
        base = abs_path[: len(abs_path) - len(ext)]
        lyr = "plain" if (os.path.exists(base + ".lrc") or os.path.exists(base + ".txt")) else "none"

        rows.append([
            "local", ptid, title, artist, album, artist,
            "" if track_no is None else str(track_no), "", "", "",
            "" if dur is None else str(dur), ext.replace(".", ""), "",
            "" if depth is None else str(depth), "" if rate is None else str(rate),
            "true" if ext in (".flac", ".wav", ".aiff", ".aif") else "false",
            str(size), digest, abs_path, cover, lyr, "completed",
        ])

    # ── self-checks ────────────────────────────────────────────────────────
    missing = [r[18] for r in rows if not os.path.exists(r[18])]
    if missing:
        problems.append(f"{len(missing)} emitted file_path(s) do not exist")
    if len(rows) != len(files):
        problems.append(f"row count {len(rows)} != file count {len(files)}")

    print(f"parsed {len(rows)} row(s)", flush=True)
    depths = {}
    for r in rows:
        depths[r[13] or "?"] = depths.get(r[13] or "?", 0) + 1
    print("bit depths:", depths, flush=True)
    print("with cover:", sum(1 for r in rows if r[19]), flush=True)
    print("with lyrics sidecar:", sum(1 for r in rows if r[20] == "plain"), flush=True)

    if problems:
        print("\nSELF-CHECK FAILED - nothing written:", file=sys.stderr)
        for p in problems[:20]:
            print("  " + p, file=sys.stderr)
        return 1

    with open(args.out, "w") as fh:
        for r in rows:
            fh.write("\t".join(x.replace("\t", " ") for x in r) + "\n")
    print(f"\nwrote {len(rows)} row(s) to {args.out}", flush=True)
    print("VERIFIED: every file_path exists, ids unique and non-URL, counts match.")
    return 0


if __name__ == "__main__":
    sys.exit(main())