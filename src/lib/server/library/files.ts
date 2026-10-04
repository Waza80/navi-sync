import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';

const log = logger;

/** Streaming SHA-256 of a file. */
export async function sha256File(path: string): Promise<string> {
	const { createReadStream } = await import('node:fs');
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(path);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

/**
 * Atomic move within the library (rename when possible, copy+delete across
 * devices). Refuses to silently overwrite an existing file with different
 * content — callers decide on conflicts first.
 */
export async function moveIntoLibrary(srcPath: string, relativeDest: string): Promise<string> {
	const dest = join(env.MUSIC_LIBRARY_DIR, relativeDest);
	await mkdir(dirname(dest), { recursive: true });
	const exists = await stat(dest).then(
		() => true,
		() => false,
	);
	if (exists) {
		const same = (await sha256File(srcPath)) === (await sha256File(dest));
		if (same) {
			await rm(srcPath, { force: true });
			log.info('identical file already in library, reusing', { relativeDest });
			return dest;
		}
		// Content differs: keep both by suffixing (never destroy user data).
		const deduped = await dedupePath(dest);
		await safeMove(srcPath, deduped);
		return deduped;
	}
	await safeMove(srcPath, dest);
	return dest;
}

async function dedupePath(path: string): Promise<string> {
	const dot = path.lastIndexOf('.');
	const base = dot > 0 ? path.slice(0, dot) : path;
	const ext = dot > 0 ? path.slice(dot) : '';
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base} (${i})${ext}`;
		const taken = await stat(candidate).then(
			() => true,
			() => false,
		);
		if (!taken) return candidate;
	}
	throw new Error(`Could not dedupe path: ${path}`);
}

async function safeMove(src: string, dest: string): Promise<void> {
	try {
		await rename(src, dest);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
			await copyFile(src, dest);
			await unlink(src);
		} else {
			throw err;
		}
	}
}

/** Remove a temp file, logging (not throwing) on failure. */
export async function cleanupTemp(path: string | null | undefined): Promise<void> {
	if (!path) return;
	try {
		await unlink(path);
	} catch (err) {
		log.debug('temp cleanup skipped', { path, error: String(err) });
	}
}

/** Defensive: wipe stale .part/.tmp leftovers older than 24h at boot. */
export async function purgeStaleTemp(): Promise<number> {
	let purged = 0;
	try {
		const entries = await readdir(env.MUSIC_TMP_DIR);
		const cutoff = Date.now() - 24 * 3600 * 1000;
		for (const name of entries) {
			const full = join(env.MUSIC_TMP_DIR, name);
			const s = await stat(full).catch(() => null);
			if (s && s.mtimeMs < cutoff) {
				await rm(full, { force: true });
				purged++;
			}
		}
	} catch {
		// tmp dir may not exist yet — nothing to purge
	}
	if (purged > 0) log.info('purged stale temp files', { count: purged });
	return purged;
}
