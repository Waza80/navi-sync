<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { live } from '$lib/stores/events.svelte';
	import JobRow from '$lib/components/JobRow.svelte';
	import TrackCard from '$lib/components/TrackCard.svelte';
	import StatCard from '$lib/components/StatCard.svelte';
	import type { TrackDTO } from '$lib/shared/types';

	let { data }: { data: {
		jobs: Parameters<typeof live.hydrate>[0];
		tracks: TrackDTO[];
		tracksTotal: number;
		stats: { total: number; lossless: number; withLyrics: number };
	} } = $props();

	let urlInput = $state('');
	let message = $state<{ tone: 'ok' | 'error'; text: string } | null>(null);
	let busy = $state(false);
	let hydrated = $state(false);

	// Upload (manual add) state
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
				uploadId?: string; ext?: string; embeddedLyrics?: boolean; missing?: string[];
				detected?: Record<string, unknown>; error?: { message: string };
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
							: '',
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
			const body = (await res.json()) as { trackId?: string; error?: { message: string } };
			if (!res.ok) {
				uploadMsg = { tone: 'error', text: body.error?.message ?? `HTTP ${res.status}` };
				return;
			}
			uploadMsg = { tone: 'ok', text: 'Saved to library ✓' };
			up = null;
			await invalidateAll();
		} finally {
			uploadBusy = false;
		}
	}

	$effect(() => {
		if (!hydrated) {
			live.hydrate(data.jobs);
			hydrated = true;
		}
		live.start(() => void invalidateAll());
	});
	// Re-hydrate when the server load refreshes (post-invalidation).
	$effect(() => {
		for (const j of data.jobs) if (!live.jobs.has(j.id)) live.jobs.set(j.id, j);
	});

	async function submitDownload(e: SubmitEvent) {
		e.preventDefault();
		message = null;
		busy = true;
		try {
			const res = await fetch('/api/tracks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: urlInput.trim() })
			});
			const body = (await res.json()) as { job?: { id: string }; error?: { message: string } };
			if (!res.ok) {
				message = { tone: 'error', text: body.error?.message ?? `HTTP ${res.status}` };
				return;
			}
			// (button is never disabled — empty input gives inline feedback)
			if (urlInput.trim().length === 0) {
				message = { tone: 'error', text: 'Paste a track URL or ID first.' };
				return;
			}
			message = { tone: 'ok', text: 'Queued — watch the live progress below.' };
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
	async function refetchLyrics(id: string) {
		await fetch(`/api/lyrics/fetch/${id}`, { method: 'POST' });
		await invalidateAll();
	}
	async function deleteTrack(id: string) {
		await fetch(`/api/tracks/${id}`, { method: 'DELETE' });
		await invalidateAll();
	}
</script>

<svelte:head>
	<title>Library — NaviSync</title>
</svelte:head>

<h1 class="mb-1 text-xl font-semibold">Library</h1>
<p class="mb-6 text-sm text-on-surface-variant">
	Paste a Deezer track link — quality, tags, lyrics and Navidrome layout are handled automatically.
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
			required
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

<!-- Manual upload -->
<section class="m3-card mb-6 p-4" aria-labelledby="upload-h">
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
				<button type="button" class="m3-btn m3-btn-filled" disabled={uploadBusy || !up.title.trim() || !up.artist.trim() || !up.album.trim()} onclick={finalizeUpload}>
					{uploadBusy ? 'Saving…' : 'Save to library'}
				</button>
				{#if up.embeddedLyrics}
					<span class="m3-chip bg-tertiary-container text-on-tertiary-container">embedded lyrics detected</span>
				{/if}
			</div>
		{/if}
	</div>
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
	<h2 class="mb-3 text-base font-medium">Queue</h2>
	{#if live.recentJobs.length === 0}
		<p class="m3-card p-6 text-center text-sm text-on-surface-variant">No jobs yet.</p>
	{:else}
		<div class="flex flex-col gap-3">
			{#each live.recentJobs as job (job.id)}
				<JobRow {job} oncancel={cancelJob} onretry={retryJob} />
			{/each}
		</div>
	{/if}
</section>

<!-- Tracks -->
<section aria-label="Tracks">
	<h2 class="mb-3 text-base font-medium">
		Tracks <span class="text-sm text-on-surface-variant">({data.tracksTotal})</span>
	</h2>
	{#if data.tracks.length === 0}
		<p class="m3-card p-6 text-center text-sm text-on-surface-variant">
			Nothing here yet — queue your first download above.
		</p>
	{:else}
		<div class="flex flex-col gap-3">
			{#each data.tracks as track (track.id)}
				<TrackCard {track} ondelete={deleteTrack} onrefetch={refetchLyrics} />
			{/each}
		</div>
	{/if}
</section>
