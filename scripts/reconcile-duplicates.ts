import 'dotenv/config';
import { Client } from 'pg';

/**
 * scripts/reconcile-duplicates.ts — collapse duplicate rows for the same song.
 *
 * Repeated retries used to INSERT instead of update: the conflict target was
 * (provider, provider_track_id), and relocating a track from Deezer to Tidal
 * changes both halves of that key, so every retry added another row. The result
 * was 47 duplicate groups covering 220 of 585 rows — eight rows for one track,
 * most of them empty shells from attempts that never downloaded anything.
 * `upsertTrack` now reuses such a shell, so this only cleans up what accumulated.
 *
 * Two rules, and the distinction matters:
 *
 *   - A row with NO file_path holds no audio. When a sibling for the same
 *     (title, artist) owns a real file, the shell is pure noise and is deleted.
 *   - A row WITH a file_path is real audio and is NEVER deleted, even if the song
 *     appears several times — removing the row would orphan the file on disk.
 *     Those groups are reported instead.
 *
 * Grouping is by normalized (title, artist): accented and cased variants are one
 * song. Albums are deliberately not part of the key, because the duplicates were
 * created across differing album attributions for a single recording; groups
 * that disagree about the album are reported as a metadata problem.
 *
 * Deletes rows only, never audio. Safe to re-run.
 *
 *   bun scripts/reconcile-duplicates.ts          # dry run (default)
 *   bun scripts/reconcile-duplicates.ts --apply  # commit
 */

const APPLY = process.argv.includes('--apply');

interface Row {
	id: string;
	title: string;
	artist: string;
	album: string | null;
	file_path: string | null;
	created_at: string;
}

/** Accent/case/punctuation-insensitive comparison key for one field. */
const norm = (v: string | null): string =>
	String(v ?? '')
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');

async function main(): Promise<void> {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is required');
	const db = new Client({ connectionString: url });
	await db.connect();

	const { rows } = await db.query<Row>(
		'SELECT id, title, artist, album, file_path, created_at FROM tracks ORDER BY created_at',
	);

	const groups = new Map<string, Row[]>();
	for (const r of rows) {
		const key = `${norm(r.title)}|${norm(r.artist)}`;
		const list = groups.get(key);
		if (list) list.push(r);
		else groups.set(key, [r]);
	}

	const doomed: string[] = [];
	let dupGroups = 0;
	let multiFile = 0;
	let albumMix = 0;
	const conflicts: Row[][] = [];

	for (const list of groups.values()) {
		if (list.length < 2) continue;
		dupGroups++;
		const withFile = list.filter((r) => r.file_path);
		const shells = list.filter((r) => !r.file_path);
		if (withFile.length > 1) multiFile++;
		if (new Set(list.map((r) => norm(r.album))).size > 1) {
			albumMix++;
			conflicts.push(list);
		}
		if (withFile.length === 0) {
			// Nothing was ever downloaded for this song: keep the single most
			// informative row so the attempt is still recorded and retryable.
			const best = list.reduce((a, b) => {
				const score = (r: Row): number => (r.album ? 2 : 0) + (r.isrc ? 1 : 0);
				return score(b) > score(a) ? b : a;
			});
			for (const r of list) if (r.id !== best.id) doomed.push(r.id);
			continue;
		}
		// A sibling owns real audio, so every shell is redundant.
		for (const r of shells) doomed.push(r.id);
	}

	console.log(`rows scanned:          ${rows.length}`);
	console.log(`duplicate groups:      ${dupGroups}`);
	console.log(`  of which >1 file:    ${multiFile}   (kept — real audio, never deleted)`);
	console.log(`  album disagreements: ${albumMix}   (metadata problem, not a duplicate)`);
	console.log(`rows to delete:        ${doomed.length}`);

	if (conflicts.length > 0) {
		console.log('\nalbum attribution conflicts (first 10):');
		for (const list of conflicts.slice(0, 10)) {
			const albums = [...new Set(list.map((r) => r.album ?? '(null)'))];
			console.log(`  ${list[0].artist} — ${list[0].title}: ${albums.join('  |  ')}`);
		}
	}

	if (!APPLY) {
		console.log('\nDRY RUN — pass --apply to delete.');
		await db.end();
		return;
	}

	const before = rows.length;
	for (let i = 0; i < doomed.length; i += 200) {
		const batch = doomed.slice(i, i + 200);
		await db.query('DELETE FROM tracks WHERE id = ANY($1::uuid[])', [batch]);
	}
	const after = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM tracks');
	const audio = await db.query<{ n: number }>(
		'SELECT count(*)::int AS n FROM tracks WHERE file_path IS NOT NULL',
	);
	const left = await db
		.query<{ n: number }>('SELECT count(*)::int AS n FROM (SELECT 1 FROM tracks GROUP BY 1) x')
		.catch(() => ({ rows: [{ n: -1 }] }));
	console.log(
		`\ndeleted ${before - after.rows[0].n} rows; ${after.rows[0].n} remain` +
			`\nrows with audio:       ${audio.rows[0].n}`,
	);
	void left;
	await db.end();
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exit(1);
});
