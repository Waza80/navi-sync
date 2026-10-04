<script lang="ts">
	import { qualityLabel, formatDuration, formatBytes } from '$lib/shared/format';
	import type { TrackDTO } from '$lib/shared/types';

	let {
		track,
		ondelete,
		onrefetch
	}: {
		track: TrackDTO;
		ondelete?: (id: string) => void;
		onrefetch?: (id: string) => void;
	} = $props();

	const lyricsBadge = $derived(
		track.lyricsStatus === 'synced'
			? { text: 'LYRICS', cls: 'bg-tertiary-container text-on-tertiary-container' }
			: track.lyricsStatus === 'plain'
				? { text: 'LYRICS PLAIN', cls: 'bg-tertiary-container text-on-tertiary-container' }
				: track.lyricsStatus === 'failed'
					? { text: 'LYRICS ✗', cls: 'bg-error-container text-on-error-container' }
					: null
	);
	const lossless = $derived(track.isLossless || track.format === 'flac');
</script>

<div
	class="m3-card flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-4"
	data-track-id={track.id}
>
	<div class="min-w-0 flex-1">
		<p class="truncate text-sm font-medium">{track.title}</p>
		<p class="truncate text-xs text-on-surface-variant">
			{track.artist}{#if track.album} · {track.album}{/if}
		</p>
	</div>
	<div class="flex flex-wrap items-center gap-2">
		<span
			class="m3-chip {lossless
				? 'bg-primary-container text-on-primary-container'
				: 'bg-secondary-container text-on-secondary-container'}"
		>
			{qualityLabel(track.format, track.bitrateKbps, track.bitDepth)}
		</span>
		{#if lyricsBadge}
			<span class="m3-chip {lyricsBadge.cls}">{lyricsBadge.text}</span>
		{/if}
		<span class="hidden text-xs text-on-surface-variant md:inline">
			{formatDuration(track.durationSec)} · {formatBytes(track.sizeBytes)}
		</span>
	</div>
	<div class="flex gap-1">
		<button
			type="button"
			class="m3-btn m3-btn-text text-xs"
			title="Refetch lyrics"
			aria-label="Refetch lyrics for {track.title}"
			onclick={() => onrefetch?.(track.id)}>Lyrics ↻</button
		>
		<button
			type="button"
			class="m3-btn m3-btn-text text-error text-xs"
			title="Delete track (files + database)"
			aria-label="Delete {track.title}"
			onclick={() => ondelete?.(track.id)}>Delete</button
		>
	</div>
</div>
