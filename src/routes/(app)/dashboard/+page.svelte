<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
	import { live } from '$lib/stores/events.svelte';
	import JobRow from '$lib/components/JobRow.svelte';
	import TrackCard from '$lib/components/TrackCard.svelte';
	import StatCard from '$lib/components/StatCard.svelte';
	import type { TrackDTO } from '$lib/shared/types';

	import { page } from '$app/state';
	import { goto } from '$app/navigation';

	let { data }: { data: {
		jobs: Parameters<typeof live.hydrate>[0];
		tracks: TrackDTO[];
		tracksTotal: number;
		failedTracks: TrackDTO[];
		failedTotal: number;
		stats: { total: number; lossless: number; withLyrics: number; failed: number };
	} } = $props();

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
			() => void invalidateAll() // resync after SSE reconnect (missed events)
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
			void goto(`${page.url.pathname}?${params.toString()}`, { replaceState: true, keepFocus: true });
		}, 300);
	}
	function gotoPage(next: number) {
		const params = new SvelteURLSearchParams(page.url.searchParams);
		params.set('page', String(next));
		// Same-page query navigation — resolve() cannot express query-only URLs.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(`${page.url.pathname}?${params.toString()}`, { replaceState: true });
	}
	const currentPage = $derived(Number.parseInt(page.url.searchParams.get('page') ?? '1', 10) || 1);
	const pageCount = $derived(Math.max(1, Math.ceil(data.tracksTotal / 50)));
	const filteredTracks = $derived(data.tracks);
	const queueCounts = $derived({
		all: live.recentJobs.length,
		active: live.recentJobs.filter((j) => j.status === 'queued' || j.status === 'running').length,
		done: live.recentJobs.filter((j) => j.status === 'succeeded' || j.status === 'cancelled').length,
		failed: live.recentJobs.filter((j) => j.status === 'failed' || j.status === 'dead').length
	});
	const visibleJobs = $derived(
		queueFilter === 'all'
			? live.recentJobs
			: live.recentJobs.filter((j) =>
					queueFilter === 'active'
						? j.status === 'queued' || j.status === 'running'
						: queueFilter === 'done'
							? j.status === 'succeeded' || j.status === 'cancelled'
							: j.status === 'failed' || j.status === 'dead'
				)
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
				body: JSON.stringify({ url: urlInput.trim() })
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
						: 'Queued — watch the live progress below.'
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
			const body = (await res.json()) as { job?: { id: string }; message?: string; error?: { message: string } };
			message = res.ok
				? { tone: 'ok', text: body.message ?? 'Quality check queued — watch the queue.' }
				: { tone: 'error', text: body.error?.message ?? body.message ?? `HTTP ${res.status}` };
			toast(message.tone, message.text);
		} finally {
			upgrading.delete(id);
		}
	}
	async function retryFailedDownload(id: string) {
		upgrading.add(id);
		try {
			const res = await fetch(`/api/tracks/${id}/retry-download`, { method: 'POST' });
			const body = (await res.json()) as { job?: { id: string }; message?: string; error?: { message: string } };
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
	let albumBusy = new SvelteSet<string>();
	let searchMsg = $state<string | null>(null);
	let queuedSearch = new SvelteSet<string>();

	function clearSearch() {
		searchInput = '';
		searchResults = [];
		searchAlbums = [];
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
			};
			searchResults = body.results ?? [];
			searchAlbums = body.albums ?? [];
			if (searchResults.length === 0) searchMsg = 'No results from the enabled providers.';
		} finally {
			searchBusy = false;
		}
	}
	async function downloadAlbum(a: AlbumResult) {
		const key = a.provider + ':' + a.albumId;
		albumBusy.add(key);
		try {
			const res = await fetch(`/api/albums/${a.albumId}/download`, { method: 'POST' });
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
			body: JSON.stringify({ provider: r.provider, trackId: r.providerTrackId })
		});
	}

	// ── Upload (manual add) ─────────────────────────────────────────────────
	let uploadBusy = $state(false);
	let uploadMsg = $state<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);
	let up = $state<{
		uploadId: string;
		ext: string;
		embeddedLyrics: boolean;
		title: string;
		artist: string;
		album: string;
		trackNumber: string;
		year: string;
	} | null>(null);

	async function inspectUpload(e: Event) {
		uploadMsg = null;
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0] ?? null;
		if (!file) return;
		uploadBusy = true;
		try {
			const fd = new FormData();
			fd.append('file', file);
			const res = await fetch('/api/upload/inspect', { method: 'POST', body: fd });
			const body = (await res.json()) as {
				uploadId?: string;
				ext?: string;
				embeddedLyrics?: boolean;
				missing?: string[];
				detected?: Record<string, unknown>;
				error?: { message: string };
			};
			if (!res.ok || !body.uploadId) {
				uploadMsg = { tone: 'error', text: body.error?.message ?? `Inspection failed (HTTP ${res.status})` };
				up = null;
				return;
			}
			up = {
				uploadId: body.uploadId,
				ext: body.ext ?? '',
				embeddedLyrics: body.embeddedLyrics ?? false,
				title: typeof body.detected?.['title'] === 'string' ? body.detected['title'] : '',
				artist: typeof body.detected?.['artist'] === 'string' ? body.detected['artist'] : '',
				album: typeof body.detected?.['album'] === 'string' ? body.detected['album'] : '',
				trackNumber:
					typeof body.detected?.['trackNumber'] === 'number'
						? String(body.detected['trackNumber'])
						: typeof body.detected?.['trackNumber'] === 'string'
							? body.detected['trackNumber']
							: '',
				year:
					typeof body.detected?.['year'] === 'number'
						? String(body.detected['year'])
						: typeof body.detected?.['year'] === 'string'
							? body.detected['year']
							: ''
			};
			const missing = body.missing ?? [];
			uploadMsg = missing.length
				? { tone: 'info', text: `Detected. Please fill: ${missing.join(', ')}.` }
				: { tone: 'info', text: 'Metadata detected — review and Save to library.' };
		} catch {
			uploadMsg = { tone: 'error', text: 'Upload inspection failed (network).' };
		} finally {
			uploadBusy = false;
			if (input) input.value = '';
		}
	}

	async function finalizeUpload() {
		if (!up) return;
		uploadBusy = true;
		uploadMsg = null;
		try {
			const res = await fetch('/api/upload', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					uploadId: up.uploadId,
					ext: up.ext,
					title: up.title.trim(),
					artist: up.artist.trim(),
					album: up.album.trim(),
					trackNumber: up.trackNumber ? Number(up.trackNumber) : null,
					year: up.year ? Number(up.year) : null,
					embeddedLyrics: up.embeddedLyrics,
					fetchLyrics: !up.embeddedLyrics
				})
			});
			const body = (await res.json()) as {
				trackId?: string;
				duplicate?: boolean;
				message?: string;
				error?: { message: string };
			};
			if (!res.ok) {
				uploadMsg = { tone: 'error', text: body.error?.message ?? `HTTP ${res.status}` };
				return;
			}
			uploadMsg = {
				tone: body.duplicate ? 'info' : 'ok',
				text: body.duplicate ? (body.message ?? 'Already in library.') : 'Saved to library ✓'
			};
			toast(body.duplicate ? 'info' : 'ok', uploadMsg.text);
			up = null;
			await invalidateAll();
		} finally {
			uploadBusy = false;
		}
	}

	// ── Playlist CSV import ─────────────────────────────────────────────────
	let csvBusy = $state(false);
	let csvMsg = $state<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);
	let csvResult = $state<{ matchedCount: number; unmatched: Array<{ title: string; artist: string; reason: string }> } | null>(null);

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
				text: `Matched & queued ${body.matchedCount ?? 0} songs · ${(body.unmatched ?? []).length} unmatched.`
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
	function togglePlay(t: TrackDTO) {
		if (nowPlaying?.id === t.id) {
			audioEl?.pause();
			nowPlaying = null;
			return;
		}
		nowPlaying = { id: t.id, title: t.title, artist: t.artist };
		// src change triggers load; autoplay after metadata is ready
		queueMicrotask(() => {
			void audioEl?.play().catch(() => undefined);
		});
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
		<label for="dl-url" class="mb-1 block text-sm text-on-surface-variant">Track URL or ID</label>
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
			<input id="q" type="search" class="m3-input" placeholder="e.g. Daft Punk One More Time" bind:value={searchInput} />
		</div>
		<div class="flex items-end gap-2">
			<button type="submit" class="m3-btn m3-btn-tonal w-full sm:w-auto" disabled={searchBusy}>
				{searchBusy ? 'Searching…' : 'Search'}
			</button>
			{#if searchInput.length > 0 || searchResults.length > 0 || searchAlbums.length > 0}
				<button
					type="button"
					class="m3-btn m3-btn-text"
					aria-label="Clear search"
					onclick={clearSearch}>✕ Clear</button
				>
			{/if}
		</div>
	</form>
	{#if searchMsg}
		<p class="mt-3 text-sm text-on-surface-variant" role="status">{searchMsg}</p>
	{/if}
	{#if searchAlbums.length > 0}
		<p class="mt-4 mb-2 text-xs font-medium text-on-surface-variant uppercase">Albums</p>
		<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
			{#each searchAlbums as a (a.provider + a.albumId)}
				{@const key = a.provider + ':' + a.albumId}
				<div class="flex items-center gap-3 rounded-xl bg-surface-low px-3 py-2 transition-transform duration-200 hover:translate-x-0.5">
					{#if a.coverUrl}
						<img src={a.coverUrl} alt="" loading="lazy" class="h-10 w-10 rounded-md object-cover" />
					{:else}
						<div class="h-10 w-10 rounded-md bg-surface-highest"></div>
					{/if}
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm">{a.title}</p>
						<p class="truncate text-xs text-on-surface-variant">
							{a.artist}{#if a.year} · {a.year}{/if}
						</p>
					</div>
					<button
						type="button"
						class="m3-btn m3-btn-tonal h-10 min-h-10 px-4 text-sm {albumBusy.has(key) ? 'opacity-50' : ''}"
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
				<div class="flex items-center gap-3 rounded-xl bg-surface-low px-3 py-2 transition-transform duration-200 hover:translate-x-0.5">
					{#if r.coverUrl}
						<img src={r.coverUrl} alt="" loading="lazy" class="h-10 w-10 rounded-md object-cover" />
					{:else}
						<div class="h-10 w-10 rounded-md bg-surface-highest"></div>
					{/if}
					<span class="m3-chip bg-secondary-container text-on-secondary-container uppercase">{r.provider}</span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm">{r.title}</p>
						<p class="truncate text-xs text-on-surface-variant">
							{r.artist}{#if r.album} · {r.album}{/if}
						</p>
					</div>
					<button
						type="button"
						class="m3-btn m3-btn-tonal h-10 min-h-10 px-4 text-sm {queuedSearch.has(key) ? 'opacity-50' : ''}"
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
			Audio file (.mp3 / .flac) — tags are auto-detected, you confirm before saving
		</label>
		<input
			id="upload-file"
			type="file"
			accept=".mp3,.flac,audio/mpeg,audio/flac"
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
		{#if up}
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label for="up-title" class="mb-1 block text-sm text-on-surface-variant">Title *</label>
					<input id="up-title" class="m3-input" bind:value={up.title} />
				</div>
				<div>
					<label for="up-artist" class="mb-1 block text-sm text-on-surface-variant">Artist *</label>
					<input id="up-artist" class="m3-input" bind:value={up.artist} />
				</div>
				<div>
					<label for="up-album" class="mb-1 block text-sm text-on-surface-variant">Album *</label>
					<input id="up-album" class="m3-input" bind:value={up.album} />
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label for="up-track" class="mb-1 block text-sm text-on-surface-variant">Track #</label>
						<input id="up-track" class="m3-input" type="number" min="0" bind:value={up.trackNumber} />
					</div>
					<div>
						<label for="up-year" class="mb-1 block text-sm text-on-surface-variant">Year</label>
						<input id="up-year" class="m3-input" type="number" min="1000" max="3000" bind:value={up.year} />
					</div>
				</div>
			</div>
			<div class="flex items-center gap-3">
				<button
					type="button"
					class="m3-btn m3-btn-filled"
					disabled={uploadBusy || up.title.trim().length === 0 || up.artist.trim().length === 0 || up.album.trim().length === 0}
					onclick={finalizeUpload}
				>
					{uploadBusy ? 'Saving…' : 'Save to library'}
				</button>
				{#if up.embeddedLyrics}
					<span class="m3-chip bg-tertiary-container text-on-tertiary-container">embedded lyrics detected</span>
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
		<code>Artist - Title</code> lines. Songs are matched strictly — unsure matches are
		reported, never guessed.
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
	<StatCard label="Active jobs" value={live.activeCount} hint={live.connected ? 'live · SSE' : 'connecting…'} />
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
			<div class="ml-auto flex items-center gap-2 text-sm text-on-surface-variant" role="navigation" aria-label="Track pages">
				<button
					type="button"
					class="m3-btn m3-btn-text h-10 min-h-10 px-3 text-sm"
					disabled={currentPage <= 1}
					onclick={() => gotoPage(currentPage - 1)}
					aria-label="Previous page">← Prev</button
				>
				<span aria-live="polite">Page {currentPage} of {pageCount}</span>
				<button
					type="button"
					class="m3-btn m3-btn-text h-10 min-h-10 px-3 text-sm"
					disabled={currentPage >= pageCount}
					onclick={() => gotoPage(currentPage + 1)}
					aria-label="Next page">Next →</button
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
				{retryAllBusy ? 'Queueing…' : `↻ Retry all failed (${data.stats.failed})`}
			</button>
		{/if}
	</div>
	{#if filteredTracks.length === 0}
		<p class="m3-card p-6 text-center text-sm text-on-surface-variant">
			{trackFilter ? `No tracks match "${trackFilter}".` : 'Nothing here yet — queue your first download above.'}
		</p>
	{:else}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
			{#each filteredTracks as track (track.id)}
				<TrackCard
					track={track}
					playing={nowPlaying?.id === track.id}
					ondelete={deleteTrack}
					onplay={(id: string) => {
						const t = filteredTracks.find((x) => x.id === id);
						if (t) togglePlay(t);
					}}
					ondownload={downloadTrackFile}
					onupgrade={(id: string) => void forceUpgrade(id)}
					onretry={(id: string) => void retryFailedDownload(id)}
				/>
			{/each}
		</div>
	{/if}

	{#if data.failedTracks.length > 0}
		<div class="mt-8 mb-3 flex flex-wrap items-center gap-2">
			<h2 class="text-base font-medium">
				Failed downloads <span class="text-sm text-on-surface-variant">({data.failedTotal})</span>
			</h2>
			<p class="w-full text-xs text-on-surface-variant">
				These have no file yet. Retry one, or retry them all at once.
			</p>
		</div>
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
			{#each data.failedTracks as track (track.id)}
				<TrackCard
					track={track}
					playing={false}
					ondelete={deleteTrack}
					onplay={(id: string) => {
						const t = data.failedTracks.find((x) => x.id === id);
						if (t) togglePlay(t);
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
	<div class="fixed inset-x-0 bottom-14 z-40 border-t border-outline-variant/40 bg-surface-container/95 px-4 py-2 backdrop-blur sm:bottom-0">
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
				class="m3-btn m3-btn-text text-sm"
				aria-label="Close preview"
				onclick={() => {
					audioEl?.pause();
					nowPlaying = null;
				}}>✕</button
			>
		</div>
	</div>
{/if}
