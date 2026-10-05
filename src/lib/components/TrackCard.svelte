<script lang="ts">
	import { qualityLabel, formatDuration } from '$lib/shared/format';
	import { HugeiconsIcon } from '@hugeicons/svelte';
	import {
		Delete02Icon,
		Download01Icon,
		PauseIcon,
		PlayIcon,
		RefreshIcon
	} from '@hugeicons/core-free-icons';
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
		track.lyricsStatus === 'synced' || track.lyricsStatus === 'plain'
			? { text: 'LYRICS', cls: 'bg-tertiary-container text-on-tertiary-container' }
			: track.lyricsStatus === 'failed'
				? { text: 'LYRICS', cls: 'bg-surface-highest text-on-surface-variant' }
				: null
	);
	const statusBadge = $derived(
		failed ? { text: 'WILL RETRY', cls: 'bg-error-container text-on-error-container' } : null
	);
	const lossless = $derived(track.isLossless || track.format === 'flac');
</script>

<!--
	Layers, outermost first: card → cover → artwork → scrim → chips → primary action.
	The chips sit ON the artwork (which is what made them read as "tags above the
	album"), and the meta block below needs no reserved space for them because they
	never overlap it — an earlier attempt padded the title with ps-[5.5rem]/pe-20 to
	"make room" for chips that live two sections higher, which crushed long titles.
	The action row uses 40dp M3 icon buttons so all three controls always fit the
	card; as full text buttons at 48px min-height with 24px side padding they
	overflowed and pushed Delete outside the card's overflow-hidden.
-->
<div class="m3-card m3-tile group relative flex flex-col overflow-hidden {playing ? 'ring-1 ring-primary' : ''}">
	<div class="relative aspect-square w-full shrink-0 self-start overflow-hidden bg-surface-highest">
		<img
			src={`/api/tracks/${track.id}/cover`}
			alt=""
			loading="lazy"
			class="h-full w-full object-cover"
			onerror={(e) => {
				(e.currentTarget as HTMLImageElement).style.display = 'none';
			}}
		/>

		<!-- Scrim: only behind the chip row, so chips stay legible on pale artwork. -->
		<div
			class="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-black/45 to-transparent"
			aria-hidden="true"
		></div>

		<!-- Chip row, layered above the scrim -->
		<div class="absolute inset-x-2 top-2 flex items-start justify-between gap-1">
			<span
				class="m3-chip {lossless
					? 'bg-primary-container text-on-primary-container'
					: 'bg-secondary-container text-on-secondary-container'}"
			>
				{qualityLabel(track.format, track.bitrateKbps, track.bitDepth)}
			</span>
			{#if statusBadge}
				<span class="m3-chip {statusBadge.cls}">{statusBadge.text}</span>
			{:else if lyricsBadge}
				<span class="m3-chip {lyricsBadge.cls}">{lyricsBadge.text}</span>
			{/if}
		</div>

		<!-- Primary action, centred on the artwork -->
		{#if failed}
			<button
				type="button"
				class="m3-icon-button absolute right-2 bottom-2 h-11 w-11 bg-error-container text-on-error-container shadow-[var(--md-elev-2)]"
				title="Retry download now"
				aria-label="Retry download of {track.title}"
				onclick={() => onretry?.(track.id)}
			>
				<HugeiconsIcon icon={RefreshIcon} size={22} strokeWidth={2} aria-hidden="true" />
			</button>
		{:else}
			<button
				type="button"
				class="m3-icon-button absolute right-2 bottom-2 h-11 w-11 bg-primary text-on-primary ring-1 ring-black/20 shadow-[var(--md-elev-3)]"
				aria-label={playing ? `Pause ${track.title}` : `Preview ${track.title}`}
				onclick={() => onplay?.(track.id)}
			>
				<HugeiconsIcon
					icon={playing ? PauseIcon : PlayIcon}
					size={22}
					strokeWidth={2}
					aria-hidden="true"
				/>
			</button>
		{/if}
	</div>

	<!-- Meta: full width, nothing overlaid, so titles truncate on their own terms. -->
	<div class="flex min-w-0 flex-1 flex-col gap-0.5 p-3">
		<p class="truncate text-sm font-medium" title={track.title}>{track.title}</p>
		<p class="truncate text-xs text-on-surface-variant" title="{track.artist} · {track.album ?? ''}">
			{track.artist}
		</p>
		<div class="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
			{#if track.album}
				<span class="min-w-0 truncate text-xs text-on-surface-variant" title={track.album}>
					{track.album}
				</span>
			{/if}
			<span class="shrink-0 text-xs text-on-surface-variant">
				{formatDuration(track.durationSec)}
			</span>
		</div>
	</div>

	<!-- Actions.
		 A failed row has no file, so it gets Retry and nothing else: Delete would
		 target something that does not exist, and "Download file" would offer to
		 save a file that was never written. A failed row only reaches this state once
		 the download is genuinely exhausted, not from a failed upgrade. -->
	<div class="flex items-center justify-around border-t border-outline-variant/30 px-1 py-1">
		{#if failed}
			<button
				type="button"
				class="m3-icon-button h-10 w-10 text-error"
				title="Retry download now"
				aria-label="Retry download of {track.title}"
				onclick={() => onretry?.(track.id)}
			>
				<HugeiconsIcon icon={RefreshIcon} size={18} strokeWidth={2} aria-hidden="true" />
			</button>
		{:else}
			<button
				type="button"
				class="m3-icon-button h-10 w-10"
				title="Download this file"
				aria-label="Download the file for {track.title}"
				onclick={() => ondownload?.(track.id)}
			>
				<HugeiconsIcon icon={Download01Icon} size={18} strokeWidth={2} aria-hidden="true" />
			</button>
			<button
				type="button"
				class="m3-icon-button h-10 w-10"
				title="Check for a better quality now"
				aria-label="Check for better quality of {track.title}"
				onclick={() => onupgrade?.(track.id)}
			>
				<HugeiconsIcon icon={RefreshIcon} size={18} strokeWidth={2} aria-hidden="true" />
			</button>
			<button
				type="button"
				class="m3-icon-button h-10 w-10 text-error"
				title="Delete track"
				aria-label="Delete {track.title}"
				onclick={() => ondelete?.(track.id)}
			>
				<HugeiconsIcon icon={Delete02Icon} size={18} strokeWidth={2} aria-hidden="true" />
			</button>
		{/if}
	</div>
</div>
