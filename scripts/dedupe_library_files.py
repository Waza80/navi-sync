#!/usr/bin/env python3
"""Remove duplicate library files, KEEPING THE BEST ONE.

Mirrors scripts/dedupe-library-files.ts for hosts without bun/node (the library
box has python3 only).

A suffix like "song (2).flac" marks a RE-DOWNLOAD, and a later fetch is often the
better encode -- that is why the quality pipeline refetched at all. So the rule is
never "keep the unprefixed original": every candidate is scored on real audio
properties and the winner survives.

Ranking: FLAC/WAV bit depth, then sample rate, then file size, then the
unprefixed name as a deterministic tie-break.

Dry run by default. Prints a DELETED_FROM -> KEPT_AT mapping on stdout with
--emit-map so the database rows can be repointed afterwards.

Usage:
  python3 dedupe.py --root /mnt/hdd/music
  python3 dedupe.py --root /mnt/hdd/music --apply --emit-map /tmp/map.tsv
"""
import argparse
import hashlib
import os
import struct
import sys

AUDIO_EXT = (".flac", ".wav", ".aiff", ".aif", ".mp3", ".m4a", ".ogg", ".opus")
# Lyrics sidecars accumulate the same suffixes. Ranked against their audio file's
# winner by preferring the sidecar of the KEPT audio; a sidecar whose base has no
# audio at all is left alone rather than guessed at.
SIDECAR_EXT = (".lrc", ".txt")


def probe(path, size):
    """(bit_depth, sample_rate) from a FLAC or WAV header, else (None, None)."""
    ext = os.path.splitext(path)[1].lower()
    try:
        with open(path, "rb") as f:
            head = f.read(128)
    except OSError:
        return (None, None)
    if ext == ".flac":
        if len(head) < 42 or head[0:4] != b"fLaC":
            return (None, None)
        # The first metadata block header sits immediately after the "fLaC" magic,
        # i.e. at offset 4. Starting at 8 skipped the header and read the
        # block-length bytes as if they were a type, so every probe returned None.
        p = 4
        while p + 4 <= len(head):
            last = head[p] & 0x80
            typ = head[p] & 0x7F
            ln = ((head[p + 1] & 0x7F) << 16) | (head[p + 2] << 8) | head[p + 3]
            if typ == 0:  # STREAMINFO, body right after the 4-byte header
                # Body: min/max blocksize (2+2), min/max framesize (3+3), then a
                # 20-bit sample rate, 3-bit channels, 5-bit (bit depth - 1), and a
                # 36-bit sample count. Verified against a real file:
                # 44 = 44100 Hz, 16-bit.
                b = head[p + 4 : p + 4 + 18]
                if len(b) >= 14:
                    rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4)
                    depth = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1
                    return (depth or None, rate or None)
                return (None, None)
            p += 4 + ln
            if last:
                break
        return (None, None)
    if ext in (".wav", ".aiff", ".aif"):
        i = head.find(b"fmt ")
        if i >= 0 and i + 24 <= len(head):
            try:
                return (struct.unpack_from("<H", head, i + 14)[0],
                        struct.unpack_from("<I", head, i + 4)[0])
            except struct.error:
                return (None, None)
    return (None, None)


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def split_name(name):
    """(base_with_ext, suffixed, index)"""
    stem, ext = os.path.splitext(name)
    if stem.endswith(")") and " (" in stem:
        head, _, tail = stem.rpartition(" (")
        if tail[:-1].isdigit():
            return (head + ext.lower(), True, int(tail[:-1]))
    return (name.lower(), False, 1)


def walk(root):
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            if fn.lower().endswith(AUDIO_EXT):
                yield os.path.join(dirpath, fn)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--emit-map", default=None)
    ap.add_argument("--limit", type=int, default=0, help="stop after N groups")
    args = ap.parse_args()

    groups = {}
    total = 0
    for path in walk(args.root):
        total += 1
        d, name = os.path.split(path)
        base, _suf, _idx = split_name(name)
        groups.setdefault(os.path.join(d, base), []).append(path)
    dupes = {k: v for k, v in groups.items() if len(v) > 1}
    print(f"scanned {total} audio file(s); {len(dupes)} recording(s) with more than one file\n")

    members = []
    for key, paths in dupes.items():
        ms = []
        for p in paths:
            name = os.path.basename(p)
            _b, suf, idx = split_name(name)
            try:
                size = os.path.getsize(p)
            except OSError:
                continue
            depth, rate = probe(p, size)
            ms.append({"path": p, "name": name, "suf": suf, "idx": idx,
                       "depth": depth or 0, "rate": rate or 0, "size": size})
        if len(ms) < 2:
            continue
        ms.sort(key=lambda m: (m["depth"], m["rate"], m["size"], 0 if not m["suf"] else 1, -m["idx"]),
               reverse=True)
        # Deterministic tie-break: unprefixed wins a true tie, then lowest suffix.
        ms.sort(key=lambda m: (-m["depth"], -m["rate"], -m["size"], m["suf"], m["idx"]))
        members.append(ms)
        if args.limit and len(members) >= args.limit:
            break

    def fmt(m):
        d = m["depth"] or "?"
        r = m["rate"] or "?"
        return f"{m['name']} [{d}bit/{r}Hz {m['size']/1048576:.1f}MiB]"

    keep_map = []
    for ms in members:
        keep, drop = ms[0], ms[1:]
        print(f"KEEP  {fmt(keep)}")
        kd = digest(keep["path"])
        for d in drop:
            same = digest(d["path"]) == kd
            print(f"  DEL {fmt(d)}  {'(identical)' if same else '*** DIFFERS ***'}")
            keep_map.append((d["path"], keep["path"]))

    # Lyrics sidecars accumulate the same suffixes, and a stale sidecar beside the
    # surviving audio is worse than none: Navidrome reads tags, but the .lrc is what
    # a player picks up. So after the audio winner is chosen, its sidecar group is
    # deduped too -- keeping the sidecar that matches the winner, else the
    # unsuffixed one, else the largest.
    sidecar_map = []
    for ms in members:
        keep = ms[0]
        kdir, kname = os.path.split(keep["path"])
        kstem, kext = os.path.splitext(kname)
        for sext in (".lrc", ".txt"):
            sibs = []
            try:
                for fn in os.listdir(kdir):
                    st, sx = os.path.splitext(fn)
                    if sx.lower() != sext:
                        continue
                    if not st.startswith(kstem):
                        continue
                    sibs.append(os.path.join(kdir, fn))
            except OSError:
                continue
            if len(sibs) < 2:
                continue
            scored = []
            for sp in sibs:
                st, _sx = os.path.splitext(os.path.basename(sp))
                match = st == kstem
                try:
                    sz = os.path.getsize(sp)
                except OSError:
                    sz = 0
                # Prefer the sidecar belonging to the winning audio, then the
                # unsuffixed name, then the largest.
                scored.append((match, not st.endswith(")"), sz, sp))
            scored.sort(key=lambda t: (t[0], t[1], t[2]), reverse=True)
            print(f"  KEEP-SIDECAR {os.path.basename(scored[0][3])}")
            for t in scored[1:]:
                print(f"    DEL-SIDECAR {os.path.basename(t[3])}")
                sidecar_map.append(t[3])

    n_del = len(keep_map) + len(sidecar_map)

    if not args.apply:
        print(f"\nDry run. {len(members)} group(s), {n_del} file(s) would be deleted.")
        print("Re-run with --apply.")
        return 0


    # Strip the suffix from the survivor.
    #
    # After the duplicates go, the best copy is often still called "song (2).flac"
    # because it was the second fetch. That is a scar from the bug: Navidrome sorts
    # and displays it, and the name no longer matches the track it holds. Renaming to
    # the clean base is the point of cleaning up at all -- and it must also carry the
    # sidecars, or a "song.lrc" beside a "song (2).lrc" is just as confusing.
    # Plan the renames now, act on them after the deletions free the clean name.
    renames = []
    for ms in members:
        keep = ms[0]
        if not keep["suf"]:
            continue
        _d, kname = os.path.split(keep["path"])
        kstem, kext = os.path.splitext(kname)
        clean_stem = kstem.rpartition(" (")[0] or kstem
        renames.append((keep["path"], os.path.join(_d, clean_stem + kext)))

    deleted = freed = 0
    for frm, to in keep_map:
        try:
            sz = os.path.getsize(frm)
            os.remove(frm)
            deleted += 1
            freed += sz
            print(f"  deleted {frm}")
        except OSError as e:
            print(f"  FAILED {frm}: {e}", file=sys.stderr)
    for frm, to in renames:
        try:
            d, fn = os.path.split(frm)
            stem, sx = os.path.splitext(fn)
            clean_stem = stem.rpartition(" (")[0] or stem
            for sext in (".lrc", ".txt"):
                src_side = os.path.join(d, stem + sext)
                dst_side = os.path.join(d, clean_stem + sext)
                if os.path.exists(src_side) and not os.path.exists(dst_side):
                    os.rename(src_side, dst_side)
                    print(f"  renamed sidecar {os.path.basename(src_side)} -> {os.path.basename(dst_side)}")
            os.rename(frm, to)
            print(f"  renamed {frm} -> {to}")
            # The map row recorded the pre-rename path; update it so the database
            # points at where the file actually ended up.
            for i, (mf, mt) in enumerate(keep_map):
                if mf == frm:
                    keep_map[i] = (mf, to)
        except OSError as e:
            print(f"  RENAME FAILED {frm}: {e}", file=sys.stderr)
    for sc in sidecar_map:
        try:
            os.remove(sc)
            deleted += 1
            print(f"  deleted {sc}")
        except OSError as e:
            print(f"  FAILED {sc}: {e}", file=sys.stderr)

    print(f"\ndeleted {deleted} file(s), {freed/1048576:.1f} MiB reclaimed")

    if args.emit_map and keep_map:
        with open(args.emit_map, "w") as fh:
            for frm, to in keep_map:
                fh.write(f"{frm}\t{to}\n")
        print(f"wrote {len(keep_map)} mapping row(s) to {args.emit_map}")
    print("Now repoint the database rows and ask Navidrome to rescan.")
    return 0


if __name__ == "__main__":
    sys.exit(main())