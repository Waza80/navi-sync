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
		<button type="submit" class="m3-btn m3-btn-filled w-full sm:w-auto" disabled={busy || urlInput.trim().length === 0}>
			{busy ? 'Queueing…' : 'Download'}
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
