<script lang="ts">
	import { qualityLabel, formatDuration } from '$lib/shared/format';
	import type { TrackDTO } from '$lib/shared/types';

	let {
		track,
		playing,
		ondelete,
		onplay,
		ondownload,
		onupgrade
	}: {
		track: TrackDTO;
		playing?: boolean;
		ondelete?: (id: string) => void;
		onplay?: (id: string) => void;
		ondownload?: (id: string) => void;
		onupgrade?: (id: string) => void;
	} = $props();

	const lyricsBadge = $derived(
		track.lyricsStatus === 'synced'
			? { text: 'LYRICS', cls: 'bg-tertiary-container text-on-tertiary-container' }
			: track.lyricsStatus === 'plain'
				? { text: 'LYRICS', cls: 'bg-tertiary-container text-on-tertiary-container' }
				: track.lyricsStatus === 'failed'
					? { text: 'LYRICS ⏳', cls: 'bg-surface-highest text-on-surface-variant' }
					: null
	);
	const lossless = $derived(track.isLossless || track.format === 'flac');
</script>

<div class="m3-card group relative flex flex-col overflow-hidden {playing ? 'ring-1 ring-primary' : ''}">
	<!-- Cover -->
	<div class="relative aspect-square w-full bg-surface-highest">
		<img
			src={`/api/tracks/${track.id}/cover`}
			alt=""
			loading="lazy"
			class="h-full w-full object-cover"
			onerror={(e) => {
				(e.currentTarget as HTMLImageElement).style.display = 'none';
			}}
		/>
		<!-- Play overlay -->
		<button
			type="button"
			class="absolute right-2 bottom-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-on-primary shadow-[var(--md-elev-2)] transition-transform hover:scale-105"
			aria-label="Preview {track.title}"
			onclick={() => onplay?.(track.id)}
		>
			{playing ? '⏸' : '▶'}
		</button>
		<span
			class="absolute top-2 left-2 m3-chip {lossless
				? 'bg-primary-container/90 text-on-primary-container'
				: 'bg-secondary-container/90 text-on-secondary-container'}"
		>
			{qualityLabel(track.format, track.bitrateKbps, track.bitDepth)}
		</span>
	</div>

	<!-- Meta -->
	<div class="flex flex-1 flex-col gap-1 p-3">
		<p class="truncate text-sm font-medium" title={track.title}>{track.title}</p>
		<p class="truncate text-xs text-on-surface-variant" title="{track.artist} · {track.album ?? ''}">
			{track.artist}
		</p>
		<div class="mt-1 flex flex-wrap items-center gap-1.5">
			{#if lyricsBadge}
				<span class="m3-chip {lyricsBadge.cls}">{lyricsBadge.text}</span>
			{/if}
			<span class="text-xs text-on-surface-variant">{formatDuration(track.durationSec)}</span>
		</div>
	</div>

	<!-- Actions -->
	<div class="flex items-center justify-between border-t border-outline-variant/30 px-2 py-1">
		<div class="flex">
			<button
				type="button"
				class="m3-btn m3-btn-text text-xs"
				title="Download this file"
				aria-label="Download {track.title}"
				onclick={() => ondownload?.(track.id)}>⬇ File</button
			>
			<button
				type="button"
				class="m3-btn m3-btn-text text-xs"
				title="Force quality check (find a better version now)"
				aria-label="Check for better quality: {track.title}"
				onclick={() => onupgrade?.(track.id)}>⚡ Upgrade</button
			>
		</div>
		<button
			type="button"
			class="m3-btn m3-btn-text text-error text-xs"
			title="Delete track"
			aria-label="Delete {track.title}"
			onclick={() => ondelete?.(track.id)}>🗑</button
		>
	</div>
</div>
