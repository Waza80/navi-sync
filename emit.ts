import { foldAlbum, splitIndexSuffix, isDuplicateOfSibling } from '/home/wyzz/navi-sync/src/lib/server/library/albumfold';
import { Client } from 'pg';
import { writeFileSync } from 'node:fs';
const c = new Client({ connectionString: process.env.PW_URL!, connectionTimeoutMillis: 15000 });
for (let i = 0; i < 25; i++) { try { await c.connect(); break; } catch { await new Promise(r => setTimeout(r, 3000)); } }
const q = async (s: string) => { for (let i = 0; i < 10; i++) { try { return await c.query(s); } catch { await new Promise(r => setTimeout(r, 3000)); } } throw new Error('fail'); };
const { rows } = await q(`select id, title, album, duration_sec, file_path from tracks where file_path is not null`);
const by = new Map<string, any[]>();
for (const r of rows) { const k = foldAlbum(r.album ?? ''); if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
const out: string[] = [];
for (const [, g] of by) {
  for (const e of g) {
    const dur = e.duration_sec == null ? null : Number(e.duration_sec);
    if (splitIndexSuffix(String(e.title ?? ''))[1] === null) continue;
    if (!isDuplicateOfSibling(String(e.title), dur, g.map(x => ({ title: String(x.title), durationSec: x.duration_sec == null ? null : Number(x.duration_sec) })))) continue;
    const f = String(e.file_path).replace('/music/', '');
    const base = splitIndexSuffix(String(e.title))[0];
    const dir = f.slice(0, f.lastIndexOf('/'));
    const name = f.slice(f.lastIndexOf('/') + 1);
    const ext = name.slice(name.lastIndexOf('.'));
    out.push(`${dir}/${name}\t${dir}/${base}${ext}`);
  }
}
writeFileSync('/tmp/opencode/renames.tsv', out.join('\n') + '\n');
console.log(out.join('\n'));
await c.end();
