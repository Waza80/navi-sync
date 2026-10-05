<script lang="ts">
	import { qualityLabel, formatDuration } from '$lib/shared/format';
	import { HugeiconsIcon } from '@hugeicons/svelte';
	import { Delete02Icon, Download01Icon, RefreshIcon } from '@hugeicons/core-free-icons';
	import type { TrackDTO } from '$lib/shared/types';

	let {
		track,
		playing,
		ondelete,
		onplay,
		ondownload,
		onupgrade,
		onretry
	}: {
		track: TrackDTO;
		playing?: boolean;
		ondelete?: (id: string) => void;
		onplay?: (id: string) => void;
		ondownload?: (id: string) => void;
		onupgrade?: (id: string) => void;
		onretry?: (id: string) => void;
	} = $props();

	const failed = $derived(track.downloadStatus === 'failed');
	const lyricsBadge = $derived(
		track.lyricsStatus === 'synced'
			? { text: 'LYRICS', cls: 'bg-tertiary-container text-on-tertiary-container' }
			: track.lyricsStatus === 'plain'
				? { text: 'LYRICS', cls: 'bg-tertiary-container text-on-tertiary-container' }
				: track.lyricsStatus === 'failed'
					? { text: 'LYRICS ⏳', cls: 'bg-surface-highest text-on-surface-variant' }
					: null
	);
	const statusBadge = $derived(
		failed ? { text: 'FAILED — will retry', cls: 'bg-error-container text-on-error-container' } : null
	);
	const lossless = $derived(track.isLossless || track.format === 'flac');
</script>

<div class="m3-card m3-tile group relative flex flex-col overflow-hidden {playing ? 'ring-1 ring-primary' : ''}">
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
		{#if failed}
			<button
				type="button"
				class="m3-icon-button absolute right-2 bottom-2 bg-error-container text-on-error-container shadow-[var(--md-elev-2)]"
				title="Retry download now"
				aria-label="Retry download {track.title}"
				onclick={() => onretry?.(track.id)}
				><HugeiconsIcon icon={RefreshIcon} size={22} strokeWidth={2} aria-hidden="true" /></button
			>
		{:else}
			<button
				type="button"
				class="absolute right-2 bottom-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-on-primary shadow-[var(--md-elev-2)] transition-transform hover:scale-105"
				aria-label="Preview {track.title}"
				onclick={() => onplay?.(track.id)}
			>
				{playing ? '⏸' : '▶'}
			</button>
		{/if}
		{#if failed}
			<span class="absolute top-2 right-2 m3-chip bg-error-container text-on-error-container">FAILED</span>
		{/if}
		<span
			class="absolute top-2 left-2 m3-chip {lossless
				? 'bg-primary-container/90 text-on-primary-container'
				: 'bg-secondary-container/90 text-on-secondary-container'}"
		>
			{qualityLabel(track.format, track.bitrateKbps, track.bitDepth)}
		</span>
	</div>

	<!-- Meta. The chips above are absolutely positioned over this block, so the
		 title and artist lines reserve room for them rather than truncating underneath. -->
	<div class="flex flex-1 flex-col gap-1 p-3 {failed ? 'pe-20' : 'pe-16'} ps-[5.5rem]">
		<p class="truncate text-sm font-medium" title={track.title}>{track.title}</p>
		<p class="truncate text-xs text-on-surface-variant" title="{track.artist} · {track.album ?? ''}">
			{track.artist}
		</p>
		<div class="mt-1 flex flex-wrap items-center gap-1.5">
			{#if statusBadge}
				<span class="m3-chip {statusBadge.cls}" title="Will retry automatically, or press Retry all failed">{statusBadge.text}</span>
			{:else if lyricsBadge}
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
				onclick={() => ondownload?.(track.id)}
				><HugeiconsIcon icon={Download01Icon} size={15} strokeWidth={2} aria-hidden="true" />File</button
			>
			<button
				type="button"
				class="m3-btn m3-btn-text text-xs"
				title="Force quality check (find a better version now)"
				aria-label="Check for better quality: {track.title}"
				onclick={() => onupgrade?.(track.id)}
				><HugeiconsIcon icon={RefreshIcon} size={15} strokeWidth={2} aria-hidden="true" />Upgrade</button
			>
		</div>
		<button
			type="button"
			class="m3-btn m3-btn-text text-error text-xs"
			title="Delete track"
			aria-label="Delete {track.title}"
			onclick={() => ondelete?.(track.id)}
				><HugeiconsIcon icon={Delete02Icon} size={15} strokeWidth={2} aria-hidden="true" /></button
		>
	</div>
</div>
