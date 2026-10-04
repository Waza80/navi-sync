<script lang="ts">
	import type { JobDTO } from '$lib/shared/types';

	let {
		job,
		oncancel,
		onretry
	}: {
		job: JobDTO;
		oncancel?: (id: string) => void;
		onretry?: (id: string) => void;
	} = $props();

	const typeLabel: Record<string, string> = {
		download: 'Download',
		lyrics: 'Lyrics',
		navidrome_scan: 'Navidrome scan',
		export: 'Export'
	};

	const statusTone: Record<string, string> = {
		queued: 'bg-secondary-container text-on-secondary-container',
		running: 'bg-primary-container text-on-primary-container',
		succeeded: 'bg-tertiary-container text-on-tertiary-container',
		failed: 'bg-error-container text-on-error-container',
		dead: 'bg-error-container text-on-error-container',
		cancelled: 'bg-surface-highest text-on-surface-variant'
	};

	const cancellable = $derived(job.status === 'queued' || job.status === 'running');
	const retryable = $derived(['failed', 'dead', 'cancelled'].includes(job.status));
</script>

<div class="m3-card flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-4">
	<span class="m3-chip {statusTone[job.status] ?? ''} w-fit uppercase">{job.status}</span>
	<div class="min-w-0 flex-1">
		<p class="truncate text-sm font-medium">
			{typeLabel[job.type] ?? job.type}
			{#if job.error}
				<span class="text-error"> — {job.error}</span>
			{/if}
		</p>
		<p class="truncate text-xs text-on-surface-variant">
			{#if job.stage}
				{job.stage}
			{:else}
				attempt {job.attempts}/{job.maxAttempts}
			{/if}
		</p>
		{#if job.status === 'running' || (job.status === 'queued' && job.progress > 0)}
			<div class="m3-progress mt-2" role="progressbar" aria-valuenow={job.progress} aria-valuemin="0" aria-valuemax="100" aria-label="Job progress">
				<div class="bar" style:width="{job.progress}%"></div>
			</div>
		{/if}
	</div>
	<div class="flex gap-2">
		{#if cancellable}
			<button type="button" class="m3-btn m3-btn-text text-sm" onclick={() => oncancel?.(job.id)}>Cancel</button>
		{/if}
		{#if retryable}
			<button type="button" class="m3-btn m3-btn-text text-sm" onclick={() => onretry?.(job.id)}>Retry</button>
		{/if}
	</div>
</div>
