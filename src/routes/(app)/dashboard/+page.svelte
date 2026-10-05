<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { tick } from 'svelte';
	import { untrack } from 'svelte';
	import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
	import { live } from '$lib/stores/events.svelte';
	import JobRow from '$lib/components/JobRow.svelte';
	import TrackCard from '$lib/components/TrackCard.svelte';
	import StatCard from '$lib/components/StatCard.svelte';
	import { expandZip, isZip } from '$lib/upload/zip';
	import { HugeiconsIcon } from '@hugeicons/svelte';
	import {
		ArrowLeft01Icon,
		ArrowRight01Icon,
		Cancel01Icon,
		GlobalRefreshIcon,
	} from '@hugeicons/core-free-icons';
	import type { TrackDTO } from '$lib/shared/types';

	import { page } from '$app/state';
	import { goto } from '$app/navigation';

	let {
		data,
	}: {
		data: {
			jobs: Parameters<typeof live.hydrate>[0];
			tracks: TrackDTO[];
			tracksTotal: number;
			failedTracks: TrackDTO[];
			failedTotal: number;
			stats: { total: number; lossless: number; withLyrics: number; failed: number };
		};
	} = $props();

	let urlInput = $state('');
	let message = $state<{ tone: 'ok' | 'error'; text: string } | null>(null);
	let busy = $state(false);

	// M3 snackbar-style toasts
	let toasts = $state<Array<{ id: number; tone: 'ok' | 'error' | 'info'; text: string }>>([]);
	let toastSeq = 0;
	function toast(tone: 'ok' | 'error' | 'info', text: string): void {
		const id = ++toastSeq;
		toasts = [...toasts, { id, tone, text }];
		setTimeout(() => {
			toasts = toasts.filter((t) => t.id !== id);
		}, 4500);
	}

	// ── Live queue (SSE) ────────────────────────────────────────────────────
	$effect(() => {
		live.start(
			() => void invalidateAll(),
			() => void invalidateAll(), // resync after SSE reconnect (missed events)
		);
	});
	// Snapshot sync must NOT read live.jobs in the same tracked scope it
	// writes to — that re-triggers the effect forever (page freeze).
	$effect(() => {
		const snapshot = data.jobs;
		untrack(() => {
			live.hydrate(snapshot);
			live.pruneNotIn(snapshot);
		});
	});

	let queueFilter = $state<'all' | 'active' | 'done' | 'failed'>('all');
	// Library filter + pagination are server-driven so they cover the whole
	// library, not just the loaded page.
	let trackFilter = $state(page.url.searchParams.get('q') ?? '');
	let filterTimer: ReturnType<typeof setTimeout> | null = null;
	function onFilterInput() {
		if (filterTimer) clearTimeout(filterTimer);
		filterTimer = setTimeout(() => {
			const params = new SvelteURLSearchParams(page.url.searchParams);
			const q = trackFilter.trim();
			if (q) params.set('q', q);
			else params.delete('q');
			params.set('page', '1');
			// Same-page query navigation — resolve() cannot express query-only URLs.
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			void goto(`${page.url.pathname}?${params.toString()}`, {
				replaceState: true,
				keepFocus: true,
			});
		}, 300);
	}
	function gotoPage(next: number) {
		const params = new SvelteURLSearchParams(page.url.searchParams);
		params.set('page', String(next));
		// Same-page query navigation — resolve() cannot express query-only URLs.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(`${page.url.pathname}?${params.toString()}`, { replaceState: true });
	}
	const currentPage = $derived(
		Number.parseInt(page.url.searchParams.get('page') ?? '1', 10) || 1,
	);
	const pageCount = $derived(Math.max(1, Math.ceil(data.tracksTotal / 50)));
	const filteredTracks = $derived(data.tracks);
	const queueCounts = $derived({
		all: live.recentJobs.length,
		active: live.recentJobs.filter((j) => j.status === 'queued' || j.status === 'running')
			.length,
		done: live.recentJobs.filter((j) => j.status === 'succeeded' || j.status === 'cancelled')
			.length,
		failed: live.recentJobs.filter((j) => j.status === 'failed' || j.status === 'dead').length,
	});
	const visibleJobs = $derived(
		queueFilter === 'all'
			? live.recentJobs
			: live.recentJobs.filter((j) =>
					queueFilter === 'active'
						? j.status === 'queued' || j.status === 'running'
						: queueFilter === 'done'
							? j.status === 'succeeded' || j.status === 'cancelled'
							: j.status === 'failed' || j.status === 'dead',
				),
	);
	let clearing = $state(false);
	async function clearFinished() {
		clearing = true;
		try {
			await fetch('/api/jobs/completed', { method: 'DELETE' });
			toast('info', 'Finished jobs cleared.');
			await invalidateAll(); // authoritative snapshot prunes the cleared rows
		} finally {
			clearing = false;
		}
	}

	// ── Add download ────────────────────────────────────────────────────────
	async function submitDownload(e: SubmitEvent) {
		e.preventDefault();
		message = null;
		if (urlInput.trim().length === 0) {
			message = { tone: 'error', text: 'Paste a track URL or ID first.' };
			return;
		}
		busy = true;
		try {
			const res = await fetch('/api/tracks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: urlInput.trim() }),
			});
			const body = (await res.json()) as {
				job?: { id: string };
				kind?: string;
				enqueued?: number;
				error?: { message: string };
			};
			if (!res.ok) {
				message = { tone: 'error', text: body.error?.message ?? `HTTP ${res.status}` };
				toast('error', message.text);
				return;
			}
			message = {
				tone: 'ok',
				text:
					body.kind === 'album' || body.kind === 'playlist'
						? `Queued ${body.enqueued} tracks from the ${body.kind}.`
						: 'Queued — watch the live progress below.',
			};
			toast('ok', message.text);
			urlInput = '';
			await invalidateAll();
		} catch {
			message = { tone: 'error', text: 'Network error while queueing the download.' };
		} finally {
			busy = false;
		}
	}

	async function cancelJob(id: string) {
		await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
	}
	async function retryJob(id: string) {
		await fetch(`/api/jobs/${id}/retry`, { method: 'POST' });
	}
	function downloadTrackFile(id: string) {
		window.open(`/api/tracks/${id}/file`, '_blank');
	}
	let upgrading = new SvelteSet<string>();
	async function forceUpgrade(id: string) {
		upgrading.add(id);
		try {
			const res = await fetch(`/api/tracks/${id}/upgrade`, { method: 'POST' });
			const body = (await res.json()) as {
				job?: { id: string };
				message?: string;
				error?: { message: string };
			};
			message = res.ok
				? { tone: 'ok', text: body.message ?? 'Quality check queued — watch the queue.' }
				: {
						tone: 'error',
						text: body.error?.message ?? body.message ?? `HTTP ${res.status}`,
					};
			toast(message.tone, message.text);
		} finally {
			upgrading.delete(id);
		}
	}
	async function setRefetchBlock(id: string, blocked: boolean) {
		try {
			const res = await fetch(`/api/tracks/${id}/refetch-block`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ blocked }),
			});
			if (!res.ok) {
				toast('error', `Could not change refetch (HTTP ${res.status})`);
				return;
			}
			toast('ok', blocked ? 'Stopped refetching this track.' : 'Refetching resumed.');
			await invalidateAll();
		} catch {
			toast('error', 'Could not change refetch (network).');
		}
	}

	async function retryFailedDownload(id: string) {
		upgrading.add(id);
		try {
			const res = await fetch(`/api/tracks/${id}/retry-download`, { method: 'POST' });
			const body = (await res.json()) as {
				job?: { id: string };
				message?: string;
				error?: { message: string };
			};
			if (res.ok) {
				toast('info', body.message ?? 'Retry queued.');
				await invalidateAll();
			} else {
				toast('error', body.message ?? body.error?.message ?? `HTTP ${res.status}`);
			}
		} finally {
			upgrading.delete(id);
		}
	}
	let retryAllBusy = $state(false);
	async function retryAllFailed() {
		retryAllBusy = true;
		try {
			const res = await fetch('/api/tracks/retry-failed', { method: 'POST' });
			const body = (await res.json()) as { requeued?: number; error?: { message: string } };
			if (res.ok) {
				toast('ok', `Requeued ${body.requeued ?? 0} failed downloads.`);
				await invalidateAll();
			} else {
				toast('error', body.error?.message ?? `HTTP ${res.status}`);
			}
		} finally {
			retryAllBusy = false;
		}
	}
	async function deleteTrack(id: string) {
		await fetch(`/api/tracks/${id}`, { method: 'DELETE' });
		if (nowPlaying?.id === id) nowPlaying = null;
		await invalidateAll();
	}

	// ── Search (providers) ──────────────────────────────────────────────────
	interface SearchResult {
		provider: string;
		providerTrackId: string;
		title: string;
		artist: string;
		album: string | null;
		durationSec: number | null;
		coverUrl?: string | null;
	}
	interface AlbumResult {
		provider: string;
		albumId: string;
		title: string;
		artist: string;
		year: number | null;
		coverUrl?: string | null;
	}
	let searchInput = $state('');
	let searchBusy = $state(false);
	let searchResults = $state<SearchResult[]>([]);
	let searchAlbums = $state<AlbumResult[]>([]);
	interface ArtistResult {
		provider: string;
		artistId: string;
		name: string;
		albumCount: number | null;
	}
	let searchArtists = $state<ArtistResult[]>([]);
	interface PastedLink {
		provider: string;
		kind: 'track' | 'album' | 'artist' | 'playlist';
		id: string;
		sourceUrl: string | null;
	}
	let pastedLink = $state<PastedLink | null>(null);
	let artistBusy = new SvelteSet<string>();
	let albumBusy = new SvelteSet<string>();
	let searchMsg = $state<string | null>(null);
	let queuedSearch = new SvelteSet<string>();

	function clearSearch() {
		searchInput = '';
		searchResults = [];
		searchAlbums = [];
		searchArtists = [];
		pastedLink = null;
		searchMsg = null;
	}

	async function doSearch(e: SubmitEvent) {
		e.preventDefault();
		if (searchInput.trim().length < 2) {
			searchMsg = 'Type at least 2 characters.';
			return;
		}
		searchBusy = true;
		searchMsg = null;
		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(searchInput.trim())}`);
			const body = (await res.json()) as {
				results?: SearchResult[];
				albums?: AlbumResult[];
				artists?: ArtistResult[];
				link?: PastedLink | null;
			};
			searchResults = body.results ?? [];
			searchAlbums = body.albums ?? [];
			searchArtists = body.artists ?? [];
			pastedLink = body.link ?? null;
			if (searchResults.length === 0) searchMsg = 'No results from the enabled providers.';
		} finally {
			searchBusy = false;
		}
	}
	async function downloadPlaylist(l: PastedLink) {
		try {
			const res = await fetch(
				`/api/playlists/${encodeURIComponent(l.id)}/download?provider=${encodeURIComponent(l.provider)}`,
				{ method: 'POST' },
			);
			const body = (await res.json()) as {
				enqueued?: number;
				truncated?: boolean;
				error?: { message: string };
			};
			if (!res.ok) {
				toast('error', body.error?.message ?? `HTTP ${res.status}`);
				return;
			}
			toast('ok', `Queued ${body.enqueued} tracks${body.truncated ? ' (capped)' : ''}`);
			await invalidateAll();
		} catch {
			toast('error', 'Could not queue the playlist (network).');
		}
	}

	async function downloadArtist(a: ArtistResult) {
		const key = a.provider + ':' + a.artistId;
		artistBusy.add(key);
		try {
			const res = await fetch(
				`/api/artists/${encodeURIComponent(a.artistId)}/download?provider=${encodeURIComponent(a.provider)}`,
				{ method: 'POST' },
			);
			const body = (await res.json()) as {
				enqueued?: number;
				albumsScanned?: number;
				truncated?: boolean;
				error?: { message: string };
			};
			if (!res.ok) {
				toast('error', body.error?.message ?? `HTTP ${res.status}`);
				return;
			}
			const capped = body.truncated ? ' (capped)' : '';
			toast(
				'ok',
				`Queued ${body.enqueued} tracks from ${body.albumsScanned} albums of “${a.name}”${capped}`,
			);
			await invalidateAll();
		} finally {
			artistBusy.delete(key);
		}
	}

	async function downloadAlbum(a: AlbumResult) {
		const key = a.provider + ':' + a.albumId;
		albumBusy.add(key);
		try {
			// Scope the id to the provider it came from: album ids are
			// provider-scoped, and guessing Deezer broke Tidal albums entirely.
			const res = await fetch(
				`/api/albums/${encodeURIComponent(a.albumId)}/download?provider=${encodeURIComponent(a.provider)}`,
				{ method: 'POST' },
			);
			const body = (await res.json()) as { enqueued?: number; error?: { message: string } };
			if (res.ok) {
				toast('ok', `Queued ${body.enqueued} tracks from “${a.title}”`);
				await invalidateAll();
			} else {
				toast('error', body.error?.message ?? `HTTP ${res.status}`);
			}
		} finally {
			albumBusy.delete(key);
		}
	}
	async function downloadResult(r: SearchResult) {
		const key = `${r.provider}:${r.providerTrackId}`;
		queuedSearch.add(key);
		await fetch('/api/jobs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ provider: r.provider, trackId: r.providerTrackId }),
		});
	}

	// ── Upload (manual add) ─────────────────────────────────────────────────
	let uploadBusy = $state(false);
	let uploadMsg = $state<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);

	/** One row per inspected file. A ZIP yields many; a single file yields one. */
	interface UploadDraft {
		uploadId: string;
		ext: string;
		entryPath: string | null;
		isrc: string;
		embeddedLyrics: boolean;
		filledBy: Record<string, string>;
		title: string;
		artist: string;
		album: string;
		trackNumber: string;
		year: string;
	}
	let ups = $state<UploadDraft[]>([]);
	/** Draft currently open in the confirm form. */
	let up = $state<UploadDraft | null>(null);
	/** Batch progress while a multi-file upload is being saved. */
	let batch = $state<{ done: number; total: number; failed: string[] } | null>(null);

	function draftFrom(body: {
		uploadId?: string;
		ext?: string;
		embeddedLyrics?: boolean;
		entryPath?: string | null;
		filledBy?: Record<string, string>;
		detected?: Record<string, unknown>;
	}): UploadDraft | null {
		if (!body.uploadId) return null;
		const d = body.detected ?? {};
		const str = (k: string): string => (typeof d[k] === 'string' ? d[k] : '');
		const num = (k: string): string =>
			typeof d[k] === 'number' ? String(d[k]) : typeof d[k] === 'string' ? d[k] : '';
		return {
			uploadId: body.uploadId,
			ext: body.ext ?? '',
			entryPath: body.entryPath ?? null,
			isrc: str('isrc'),
			embeddedLyrics: body.embeddedLyrics ?? false,
			filledBy: body.filledBy ?? {},
			title: str('title'),
			artist: str('artist'),
			album: str('album'),
			trackNumber: num('trackNumber'),
			year: num('year'),
		};
	}

	async function inspectOne(file: File, entryPath: string | null): Promise<UploadDraft | null> {
		const fd = new FormData();
		fd.append('file', file);
		if (entryPath) fd.append('entryPath', entryPath);
		const res = await fetch('/api/upload/inspect', { method: 'POST', body: fd });
		const body = (await res.json()) as {
			uploadId?: string;
			ext?: string;
			embeddedLyrics?: boolean;
			entryPath?: string | null;
			filledBy?: Record<string, string>;
			detected?: Record<string, unknown>;
			error?: { message: string };
		};
		if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
		return draftFrom(body);
	}

	/**
	 * Inspect a picked file. A `.zip` is expanded **in the browser** so the
	 * server only ever receives plain audio over the existing single-file
	 * endpoint, and a zip bomb is bounded before anything is uploaded.
	 */
	async function inspectUpload(e: Event) {
		uploadMsg = null;
		batch = null;
		ups = [];
		up = null;
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0] ?? null;
		if (!file) return;
		uploadBusy = true;
		try {
			if (isZip(file.name)) {
				const { files, skipped } = await expandZip(file);
				if (files.length === 0) {
					uploadMsg = {
						tone: 'error',
						text:
							`No audio files found in ${file.name}.` +
							(skipped.length ? ` Skipped ${skipped.length}.` : ''),
					};
					return;
				}
				ups = files.map((f) => ({
					uploadId: '',
					ext: f.name.slice(f.name.lastIndexOf('.')),
					entryPath: f.entryPath,
					isrc: '',
					embeddedLyrics: false,
					filledBy: {},
					title: '',
					artist: f.hints.artist ?? '',
					album: f.hints.album ?? '',
					trackNumber: f.hints.trackNumber != null ? String(f.hints.trackNumber) : '',
					year: '',
				}));
				// Inspect sequentially: the catalog lookup is per-file and hammering
				// it in parallel would just earn rate limits.
				for (let i = 0; i < files.length; i++) {
					try {
						const d = await inspectOne(files[i].file, files[i].entryPath);
						if (d) ups[i] = d;
					} catch (err) {
						uploadMsg = {
							tone: 'error',
							text: `${files[i].name}: ${String(err).slice(0, 120)}`,
						};
					}
				}
				const autoFilled = ups.filter((d) => Object.keys(d.filledBy).length > 0).length;
				uploadMsg = {
					tone: 'info',
					text:
						`${ups.length} track(s) from ${file.name}` +
						(autoFilled
							? ` — metadata filled for ${autoFilled} from the catalog`
							: '') +
						(skipped.length ? `. Skipped ${skipped.length} non-audio file(s).` : '.') +
						' Review, then Save all.',
				};
			} else {
				const d = await inspectOne(file, null);
				ups = d ? [d] : [];
				up = d;
				if (d) {
					const filled = Object.keys(d.filledBy);
					uploadMsg = {
						tone: 'info',
						text: filled.length
							? `Detected; filled ${filled.join(', ')} from the catalog. Review and save.`
							: 'Metadata detected — review and Save to library.',
					};
				}
			}
		} catch (err) {
			uploadMsg = {
				tone: 'error',
				text: `Upload inspection failed: ${String(err).slice(0, 140)}`,
			};
			ups = [];
			up = null;
		} finally {
			uploadBusy = false;
			if (input) input.value = '';
		}
	}

	/** Persist one draft. Returns null on success, or an error string. */
	async function saveDraft(d: UploadDraft): Promise<string | null> {
		try {
			const res = await fetch('/api/upload', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					uploadId: d.uploadId,
					ext: d.ext,
					title: d.title.trim(),
					artist: d.artist.trim(),
					album: d.album.trim(),
					trackNumber: d.trackNumber ? Number(d.trackNumber) : null,
					year: d.year ? Number(d.year) : null,
					isrc: d.isrc.trim() || null,
					embeddedLyrics: d.embeddedLyrics,
					fetchLyrics: !d.embeddedLyrics,
				}),
			});
			const body = (await res.json()) as {
				duplicate?: boolean;
				message?: string;
				error?: { message: string };
			};
			if (!res.ok) return body.error?.message ?? `HTTP ${res.status}`;
			return null;
		} catch (err) {
			return String(err).slice(0, 120);
		}
	}

	async function saveAllUploads() {
		if (ups.length === 0) return;
		uploadBusy = true;
		const failed: string[] = [];
		batch = { done: 0, total: ups.length, failed };
		for (const d of ups) {
			const err = await saveDraft(d);
			if (err) failed.push(`${d.title || d.entryPath || 'track'}: ${err}`);
			batch.done++;
			batch = { ...batch };
		}
		const okCount = batch.done - failed.length;
		batch = null;
		ups = [];
		up = null;
		const summary =
			failed.length === 0
				? { tone: 'ok' as const, text: `${okCount} track(s) saved to library ✓` }
				: {
						tone: 'info' as const,
						text: `${okCount} saved, ${failed.length} failed — ${failed[0]}`,
					};
		uploadMsg = summary;
		toast(summary.tone, summary.text);
		await invalidateAll();
		uploadBusy = false;
	}

	async function finalizeUpload() {
		if (!up) return;
		uploadBusy = true;
		uploadMsg = null;
		try {
			const err = await saveDraft(up);
			if (err) {
				uploadMsg = { tone: 'error', text: err };
				return;
			}
			uploadMsg = { tone: 'ok', text: 'Saved to library ✓' };
			toast('ok', uploadMsg.text);
			up = null;
			ups = [];
			await invalidateAll();
		} finally {
			uploadBusy = false;
		}
	}

	// ── Playlist CSV import ─────────────────────────────────────────────────
	let csvBusy = $state(false);
	let csvMsg = $state<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);
	let csvResult = $state<{
		matchedCount: number;
		unmatched: Array<{ title: string; artist: string; reason: string }>;
	} | null>(null);

	async function importCsv(e: Event) {
		csvMsg = null;
		csvResult = null;
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		csvBusy = true;
		try {
			const fd = new FormData();
			fd.append('file', file);
			const res = await fetch('/api/playlist/import', { method: 'POST', body: fd });
			const body = (await res.json()) as {
				matchedCount?: number;
				unmatched?: Array<{ title: string; artist: string; reason: string }>;
				error?: { message: string };
			};
			if (!res.ok) {
				csvMsg = { tone: 'error', text: body.error?.message ?? `HTTP ${res.status}` };
				return;
			}
			csvResult = { matchedCount: body.matchedCount ?? 0, unmatched: body.unmatched ?? [] };
			csvMsg = {
				tone: (body.matchedCount ?? 0) > 0 ? 'ok' : 'info',
				text: `Matched & queued ${body.matchedCount ?? 0} songs · ${(body.unmatched ?? []).length} unmatched.`,
			};
			toast('ok', csvMsg.text);
			await invalidateAll();
		} finally {
			csvBusy = false;
			if (input) input.value = '';
		}
	}

	// ── Preview player ──────────────────────────────────────────────────────
	let nowPlaying = $state<{ id: string; title: string; artist: string } | null>(null);
	let audioEl: HTMLAudioElement | null = $state(null);

	async function togglePlay(t: TrackDTO) {
		if (nowPlaying?.id === t.id) {
			audioEl?.pause();
			nowPlaying = null;
			await invalidateAll();
			return;
		}
		nowPlaying = { id: t.id, title: t.title, artist: t.artist };
		// The <audio> element lives inside an {#if nowPlaying} block, so it does
		// not exist until Svelte has flushed this state change. A queueMicrotask
		// runs BEFORE that flush, so audioEl was still null and playback silently
		// never started — which read as "the button does nothing".
		await tick();
		try {
			await audioEl?.play();
		} catch {
			// Autoplay can be refused; the card still reflects the paused state.
		}
	}
</script>

<svelte:head>
	<title>Library — NaviSync</title>
</svelte:head>

<h1 class="mb-1 text-xl font-semibold">Library</h1>
<p class="mb-6 text-sm text-on-surface-variant">
	Download, upload, search and preview — everything files itself into Navidrome layout.
</p>

<!-- Add download -->
<form onsubmit={submitDownload} class="m3-card mb-6 flex flex-col gap-3 p-4 sm:flex-row">
	<div class="flex-1">
		<label for="dl-url" class="mb-1 block text-sm text-on-surface-variant"
			>Track URL or ID</label
		>
		<input
			id="dl-url"
			type="url"
			class="m3-input"
			placeholder="https://www.deezer.com/track/3135556"
			bind:value={urlInput}
		/>
	</div>
	<div class="flex items-end">
		<button type="submit" class="m3-btn m3-btn-filled w-full sm:w-auto" disabled={busy}>
			{busy ? 'Queueing…' : 'Add to queue'}
		</button>
	</div>
</form>

{#if message}
	<p
		class="mb-6 rounded-lg px-3 py-2 text-sm {message.tone === 'ok'
			? 'bg-tertiary-container text-on-tertiary-container'
			: 'bg-error-container text-on-error-container'}"
		role="status"
	>
		{message.text}
	</p>
{/if}

<!-- Search providers -->
<section class="m3-card mb-6 p-4" aria-labelledby="search-h">
	<h2 id="search-h" class="mb-3 text-base font-medium">Search providers</h2>
	<form onsubmit={doSearch} class="flex flex-col gap-3 sm:flex-row">
		<div class="flex-1">
			<label for="q" class="mb-1 block text-sm text-on-surface-variant">Song or artist</label>
			<input
				id="q"
				type="search"
				class="m3-input"
				placeholder="e.g. Daft Punk One More Time"
				bind:value={searchInput}
			/>
		</div>
		<div class="flex items-end gap-2">
			<button
				type="submit"
				class="m3-btn m3-btn-tonal w-full sm:w-auto"
				disabled={searchBusy}
			>
				{searchBusy ? 'Searching…' : 'Search'}
			</button>
			{#if searchInput.length > 0 || searchResults.length > 0 || searchAlbums.length > 0}
				<button
					type="button"
					class="m3-btn m3-btn-text"
					aria-label="Clear search"
					onclick={clearSearch}
					><HugeiconsIcon
						icon={Cancel01Icon}
						size={16}
						strokeWidth={2}
						aria-hidden="true"
					/>Clear</button
				>
			{/if}
		</div>
	</form>
	{#if searchMsg}
		<p class="mt-3 text-sm text-on-surface-variant" role="status">{searchMsg}</p>
	{/if}
	{#if searchArtists.length > 0}
		<p class="mt-4 mb-2 text-xs font-medium text-on-surface-variant uppercase">Artists</p>
		<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
			{#each searchArtists as a (a.provider + ':' + a.artistId)}
				{@const key = a.provider + ':' + a.artistId}
				<div class="flex items-center gap-3 rounded-xl bg-surface-low px-3 py-2">
					<span
						class="m3-chip bg-secondary-container text-on-secondary-container uppercase"
					>
						{a.provider}
					</span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm">{a.name}</p>
						<p class="truncate text-xs text-on-surface-variant">
							{a.albumCount ?? 0} albums
						</p>
					</div>
					<button
						type="button"
						class="m3-btn m3-btn-tonal h-10 min-h-10 px-4 text-sm {artistBusy.has(key)
							? 'opacity-50'
							: ''}"
						disabled={artistBusy.has(key)}
						onclick={() => downloadArtist(a)}
					>
						{artistBusy.has(key) ? 'Queueing…' : 'Download all'}
					</button>
				</div>
			{/each}
		</div>
	{/if}
	{#if pastedLink}
		{@const link = pastedLink}
		<p class="mt-4 mb-2 text-xs font-medium text-on-surface-variant uppercase">Pasted link</p>
		<div class="flex items-center gap-3 rounded-xl bg-surface-low px-3 py-2">
			<span class="m3-chip bg-secondary-container text-on-secondary-container uppercase">
				{link.provider}
			</span>
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm">
					{link.kind === 'track'
						? 'Track'
						: pastedLink.kind.charAt(0).toUpperCase() + pastedLink.kind.slice(1)}
					{link.sourceUrl ?? link.id}
				</p>
			</div>
			{#if pastedLink.kind === 'artist'}
				<button
					type="button"
					class="m3-btn m3-btn-tonal h-10 min-h-10 px-4 text-sm"
					onclick={() =>
						downloadArtist({
							provider: link.provider,
							artistId: link.id,
							name: link.sourceUrl ?? 'this artist',
							albumCount: null,
						})}
				>
					Download all
				</button>
			{:else if pastedLink.kind === 'album'}
				<button
					type="button"
					class="m3-btn m3-btn-tonal h-10 min-h-10 px-4 text-sm"
					onclick={() =>
						downloadAlbum({
							provider: link.provider,
							albumId: link.id,
							title: link.sourceUrl ?? 'album',
							artist: '',
							year: null,
							coverUrl: null,
						})}
				>
					Download album
				</button>
			{:else if pastedLink.kind === 'playlist'}
				<!-- A POST fan-out, not navigation, so a button rather than a link. -->
				<button
					type="button"
					class="m3-btn m3-btn-tonal h-10 min-h-10 px-4 text-sm"
					onclick={() => void downloadPlaylist(link)}
				>
					Download playlist
				</button>
			{/if}
		</div>
	{/if}
	{#if searchAlbums.length > 0}
		<p class="mt-4 mb-2 text-xs font-medium text-on-surface-variant uppercase">Albums</p>
		<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
			{#each searchAlbums as a (a.provider + a.albumId)}
				{@const key = a.provider + ':' + a.albumId}
				<div
					class="flex items-center gap-3 rounded-xl bg-surface-low px-3 py-2 transition-transform duration-200 hover:translate-x-0.5"
				>
					{#if a.coverUrl}
						<img
							src={a.coverUrl}
							alt=""
							loading="lazy"
							class="h-10 w-10 rounded-md object-cover"
						/>
					{:else}
						<div class="h-10 w-10 rounded-md bg-surface-highest"></div>
					{/if}
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm">{a.title}</p>
						<p class="truncate text-xs text-on-surface-variant">
							{a.artist}{#if a.year}
								· {a.year}{/if}
						</p>
					</div>
					<button
						type="button"
						class="m3-btn m3-btn-tonal h-10 min-h-10 px-4 text-sm {albumBusy.has(key)
							? 'opacity-50'
							: ''}"
						disabled={albumBusy.has(key)}
						onclick={() => downloadAlbum(a)}
					>
						{albumBusy.has(key) ? 'Queueing…' : 'Download album'}
					</button>
				</div>
			{/each}
		</div>
	{/if}
	{#if searchResults.length > 0}
		<p class="mt-4 mb-2 text-xs font-medium text-on-surface-variant uppercase">Tracks</p>
		<div class="mt-3 flex flex-col gap-2">
			{#each searchResults as r (r.provider + r.providerTrackId)}
				{@const key = r.provider + ':' + r.providerTrackId}
				<div
					class="flex items-center gap-3 rounded-xl bg-surface-low px-3 py-2 transition-transform duration-200 hover:translate-x-0.5"
				>
					{#if r.coverUrl}
						<img
							src={r.coverUrl}
							alt=""
							loading="lazy"
							class="h-10 w-10 rounded-md object-cover"
						/>
					{:else}
						<div class="h-10 w-10 rounded-md bg-surface-highest"></div>
					{/if}
					<span
						class="m3-chip bg-secondary-container text-on-secondary-container uppercase"
						>{r.provider}</span
					>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm">{r.title}</p>
						<p class="truncate text-xs text-on-surface-variant">
							{r.artist}{#if r.album}
								· {r.album}{/if}
						</p>
					</div>
					<button
						type="button"
						class="m3-btn m3-btn-tonal h-10 min-h-10 px-4 text-sm {queuedSearch.has(key)
							? 'opacity-50'
							: ''}"
						disabled={queuedSearch.has(key)}
						onclick={() => downloadResult(r)}
					>
						{queuedSearch.has(key) ? 'Queued ✓' : 'Download'}
					</button>
				</div>
			{/each}
		</div>
	{/if}
</section>

<!-- Manual upload -->
<section class="m3-card mt-0 mb-6 p-5" aria-labelledby="upload-h">
	<h2 id="upload-h" class="mb-3 text-base font-medium">Add a local file</h2>
	<div class="flex flex-col gap-3">
		<label for="upload-file" class="text-sm text-on-surface-variant">
			Audio file or .zip album — tags are auto-detected and missing metadata is filled from
			MusicBrainz/Apple, you confirm before saving
		</label>
		<input
			id="upload-file"
			type="file"
			accept=".mp3,.flac,.m4a,.wav,.ogg,.opus,.aac,.zip,audio/*"
			class="m3-input file:mr-3 file:rounded-full file:border-0 file:bg-secondary-container file:px-4 file:py-2 file:text-on-secondary-container"
			disabled={uploadBusy}
			onchange={inspectUpload}
		/>
		{#if uploadMsg}
			<p
				class="rounded-lg px-3 py-2 text-sm {uploadMsg.tone === 'ok'
					? 'bg-tertiary-container text-on-tertiary-container'
					: uploadMsg.tone === 'error'
						? 'bg-error-container text-on-error-container'
						: 'bg-surface-highest text-on-surface-variant'}"
				role="status"
			>
				{uploadMsg.text}
			</p>
		{/if}
		{#if batch}
			<div class="flex items-center gap-3 text-sm text-on-surface-variant" role="status">
				<progress class="progress" value={batch.done} max={batch.total}></progress>
				<span>{batch.done} / {batch.total}</span>
			</div>
		{/if}
		{#if ups.length > 1}
			<div class="overflow-x-auto rounded-lg border border-outline-variant">
				<table class="w-full text-left text-sm">
					<thead class="bg-surface-highest text-on-surface-variant">
						<tr>
							<th class="px-2 py-1 font-medium">#</th>
							<th class="px-2 py-1 font-medium">Title</th>
							<th class="px-2 py-1 font-medium">Artist</th>
							<th class="px-2 py-1 font-medium">Album</th>
							<th class="px-2 py-1 font-medium">Metadata</th>
						</tr>
					</thead>
					<tbody>
						{#each ups as d, i (d.uploadId || i)}
							<tr class="border-t border-outline-variant">
								<td class="px-2 py-1 text-on-surface-variant"
									>{d.trackNumber || '—'}</td
								>
								<td class="px-2 py-1">{d.title || d.entryPath || '—'}</td>
								<td class="px-2 py-1">{d.artist || '—'}</td>
								<td class="px-2 py-1">{d.album || '—'}</td>
								<td class="px-2 py-1 text-on-surface-variant">
									{Object.keys(d.filledBy).length
										? Object.keys(d.filledBy).join(', ')
										: 'file'}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="flex items-center gap-3">
				<button
					type="button"
					class="m3-btn m3-btn-filled"
					disabled={uploadBusy ||
						ups.some((d) => !d.title.trim() || !d.artist.trim() || !d.album.trim())}
					onclick={saveAllUploads}
				>
					{uploadBusy ? 'Saving…' : `Save all ${ups.length} tracks`}
				</button>
				{#if ups.some((d) => !d.title.trim() || !d.artist.trim() || !d.album.trim())}
					<span class="text-sm text-on-surface-variant"
						>Fill the blank cells to continue.</span
					>
				{/if}
			</div>
		{/if}
		{#if up}
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label for="up-title" class="mb-1 block text-sm text-on-surface-variant"
						>Title *</label
					>
					<input id="up-title" class="m3-input" bind:value={up.title} />
				</div>
				<div>
					<label for="up-artist" class="mb-1 block text-sm text-on-surface-variant"
						>Artist *</label
					>
					<input id="up-artist" class="m3-input" bind:value={up.artist} />
				</div>
				<div>
					<label for="up-album" class="mb-1 block text-sm text-on-surface-variant"
						>Album *</label
					>
					<input id="up-album" class="m3-input" bind:value={up.album} />
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label for="up-track" class="mb-1 block text-sm text-on-surface-variant"
							>Track #</label
						>
						<input
							id="up-track"
							class="m3-input"
							type="number"
							min="0"
							bind:value={up.trackNumber}
						/>
					</div>
					<div>
						<label for="up-year" class="mb-1 block text-sm text-on-surface-variant"
							>Year</label
						>
						<input
							id="up-year"
							class="m3-input"
							type="number"
							min="1000"
							max="3000"
							bind:value={up.year}
						/>
					</div>
				</div>
			</div>
			<div class="flex items-center gap-3">
				<button
					type="button"
					class="m3-btn m3-btn-filled"
					disabled={uploadBusy ||
						up.title.trim().length === 0 ||
						up.artist.trim().length === 0 ||
						up.album.trim().length === 0}
					onclick={finalizeUpload}
				>
					{uploadBusy ? 'Saving…' : 'Save to library'}
				</button>
				{#if up.embeddedLyrics}
					<span class="m3-chip bg-tertiary-container text-on-tertiary-container"
						>embedded lyrics detected</span
					>
				{/if}
			</div>
		{/if}
	</div>
</section>

<!-- Playlist CSV import -->
<section class="m3-card mb-6 p-5" aria-labelledby="csv-h">
	<h2 id="csv-h" class="mb-3 text-base font-medium">Import playlist (CSV)</h2>
	<p class="mb-3 text-sm text-on-surface-variant">
		Spotify-style exports (Track Name / Artist Name(s) / Duration) or simple
		<code>Artist - Title</code> lines. Songs are matched strictly — unsure matches are reported,
		never guessed.
	</p>
	<input
		id="csv-file"
		type="file"
		accept=".csv,text/csv"
		class="m3-input file:mr-3 file:rounded-full file:border-0 file:bg-secondary-container file:px-4 file:py-2 file:text-on-secondary-container"
		disabled={csvBusy}
		onchange={importCsv}
	/>
	{#if csvMsg}
		<p
			class="mt-3 rounded-lg px-3 py-2 text-sm {csvMsg.tone === 'ok'
				? 'bg-tertiary-container text-on-tertiary-container'
				: csvMsg.tone === 'error'
					? 'bg-error-container text-on-error-container'
					: 'bg-surface-highest text-on-surface-variant'}"
			role="status"
		>
			{csvMsg.text}
		</p>
	{/if}
	{#if csvResult && csvResult.unmatched.length > 0}
		<div class="mt-3 rounded-xl bg-surface-low p-3">
			<p class="mb-2 text-xs font-medium text-on-surface-variant uppercase">Unmatched</p>
			<ul class="flex flex-col gap-1 text-sm">
				{#each csvResult.unmatched as u (u.title + u.artist)}
					<li class="text-on-surface-variant">
						{u.title} — {u.artist} <span class="text-xs">({u.reason})</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>

<!-- Stats -->
<div class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
	<StatCard label="Tracks" value={data.stats.total} />
	<StatCard label="Lossless" value={data.stats.lossless} hint="FLAC in library" />
	<StatCard label="With lyrics" value={data.stats.withLyrics} />
	<StatCard
		label="Active jobs"
		value={live.activeCount}
		hint={live.connected ? 'live · SSE' : 'connecting…'}
	/>
</div>

<!-- Live queue -->
<section class="mb-8" aria-label="Download queue" aria-live="polite">
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<h2 class="text-base font-medium">Queue</h2>
		<div class="ml-auto flex flex-wrap gap-1" role="tablist" aria-label="Queue filter">
			{#each [['all', `All ${queueCounts.all}`], ['active', `Active ${queueCounts.active}`], ['done', `Done ${queueCounts.done}`], ['failed', `Failed ${queueCounts.failed}`]] as [key, label] (key)}
				<button
					type="button"
					role="tab"
					aria-selected={queueFilter === key}
					class="rounded-full px-3 py-1.5 text-xs {queueFilter === key
						? 'bg-secondary-container text-on-secondary-container'
						: 'text-on-surface-variant hover:bg-surface-highest'}"
					onclick={() => (queueFilter = key as typeof queueFilter)}
				>
					{label}
				</button>
			{/each}
			<button
				type="button"
				class="rounded-full px-3 py-1.5 text-xs text-error hover:bg-error-container/40"
				disabled={clearing || queueCounts.done + queueCounts.failed === 0}
				onclick={clearFinished}
			>
				{clearing ? 'Clearing…' : 'Clear finished'}
			</button>
		</div>
	</div>
	{#if visibleJobs.length === 0}
		<p class="m3-card p-6 text-center text-sm text-on-surface-variant">
			{queueFilter === 'all' ? 'No jobs yet.' : 'Nothing in this filter.'}
		</p>
	{:else}
		<div class="flex flex-col gap-3">
			{#each visibleJobs as job (job.id)}
				<JobRow {job} oncancel={cancelJob} onretry={retryJob} />
			{/each}
		</div>
	{/if}
</section>

<!-- Tracks -->
<section aria-label="Tracks">
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<h2 class="text-base font-medium">
			Tracks <span class="text-sm text-on-surface-variant">({data.tracksTotal} files)</span>
		</h2>
		<input
			type="search"
			class="m3-input h-10 min-h-10 w-full max-w-xs px-3 py-1 text-sm sm:ml-2 sm:w-auto"
			placeholder="Filter library…"
			aria-label="Filter library across all tracks"
			bind:value={trackFilter}
			oninput={onFilterInput}
		/>
		{#if pageCount > 1}
			<div
				class="ml-auto flex items-center gap-2 text-sm text-on-surface-variant"
				role="navigation"
				aria-label="Track pages"
			>
				<button
					type="button"
					class="m3-btn m3-btn-text h-10 min-h-10 px-3 text-sm"
					disabled={currentPage <= 1}
					onclick={() => gotoPage(currentPage - 1)}
					aria-label="Previous page"
					><HugeiconsIcon
						icon={ArrowLeft01Icon}
						size={16}
						strokeWidth={2}
						aria-hidden="true"
					/>Prev</button
				>
				<span aria-live="polite">Page {currentPage} of {pageCount}</span>
				<button
					type="button"
					class="m3-btn m3-btn-text h-10 min-h-10 px-3 text-sm"
					disabled={currentPage >= pageCount}
					onclick={() => gotoPage(currentPage + 1)}
					aria-label="Next page"
					>Next<HugeiconsIcon
						icon={ArrowRight01Icon}
						size={16}
						strokeWidth={2}
						aria-hidden="true"
					/></button
				>
			</div>
		{/if}
		{#if data.stats.failed > 0}
			<button
				type="button"
				class="m3-btn m3-btn-tonal ml-auto h-10 min-h-10 px-4 text-sm"
				disabled={retryAllBusy}
				onclick={retryAllFailed}
				aria-label="Retry all failed downloads now"
			>
				{retryAllBusy
					? 'Queueing…'
					: `Retry all failed (${data.stats.failed})`}<HugeiconsIcon
					icon={GlobalRefreshIcon}
					size={16}
					strokeWidth={2}
					aria-hidden="true"
				/>
			</button>
		{/if}
	</div>
	{#if filteredTracks.length === 0}
		<p class="m3-card p-6 text-center text-sm text-on-surface-variant">
			{trackFilter
				? `No tracks match "${trackFilter}".`
				: 'Nothing here yet — queue your first download above.'}
		</p>
	{:else}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
			{#each filteredTracks as track (track.id)}
				<TrackCard
					{track}
					playing={nowPlaying?.id === track.id}
					ondelete={deleteTrack}
					onplay={(id: string) => {
						const t = filteredTracks.find((x) => x.id === id);
						if (t) void togglePlay(t);
					}}
					ondownload={downloadTrackFile}
					onupgrade={(id: string) => void forceUpgrade(id)}
					onretry={(id: string) => void retryFailedDownload(id)}
					onrefetchblock={(id: string, blocked: boolean) =>
						void setRefetchBlock(id, blocked)}
				/>
			{/each}
		</div>
	{/if}

	{#if data.failedTracks.length > 0}
		<div class="mt-8 mb-3 flex flex-wrap items-center gap-2">
			<h2 class="text-base font-medium">
				Failed downloads <span class="text-sm text-on-surface-variant"
					>({data.failedTotal})</span
				>
			</h2>
			<p class="w-full text-xs text-on-surface-variant">
				These have no file yet. Retry one, or retry them all at once.
			</p>
		</div>
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
			{#each data.failedTracks as track (track.id)}
				<TrackCard
					{track}
					playing={false}
					ondelete={deleteTrack}
					onplay={(id: string) => {
						const t = data.failedTracks.find((x) => x.id === id);
						if (t) void togglePlay(t);
					}}
					ondownload={downloadTrackFile}
					onupgrade={(id: string) => void forceUpgrade(id)}
					onretry={(id: string) => void retryFailedDownload(id)}
				/>
			{/each}
		</div>
	{/if}
</section>

<!-- Toasts (M3 snackbar) -->
<div class="pointer-events-none fixed top-16 right-4 z-50 flex flex-col gap-2" aria-live="polite">
	{#each toasts as t (t.id)}
		<div
			class="m3-toast m3-enter {t.tone === 'ok'
				? 'bg-inverse-surface text-inverse-on-surface'
				: t.tone === 'error'
					? 'bg-error-container text-on-error-container'
					: 'bg-secondary-container text-on-secondary-container'}"
			role="status"
		>
			{t.text}
		</div>
	{/each}
</div>

<!-- Preview player -->
{#if nowPlaying}
	<div
		class="fixed inset-x-0 bottom-14 z-40 border-t border-outline-variant/40 bg-surface-container/95 px-4 py-2 backdrop-blur sm:bottom-0"
	>
		<div class="mx-auto flex max-w-5xl items-center gap-3">
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-medium">{nowPlaying.title}</p>
				<p class="truncate text-xs text-on-surface-variant">{nowPlaying.artist}</p>
			</div>
			<audio
				bind:this={audioEl}
				src="/api/tracks/{nowPlaying.id}/audio"
				controls
				class="h-10 w-full max-w-md"
				onpause={() => undefined}
			></audio>
			<button
				type="button"
				class="m3-icon-button text-sm"
				aria-label="Close preview"
				onclick={() => {
					audioEl?.pause();
					nowPlaying = null;
				}}
				><HugeiconsIcon
					icon={Cancel01Icon}
					size={18}
					strokeWidth={2}
					aria-hidden="true"
				/></button
			>
		</div>
	</div>
{/if}
