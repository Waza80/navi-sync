<script lang="ts">
	import type { JobDTO } from '$lib/shared/types';
	import { formatRelativeTime } from '$lib/shared/format';
	import { jobStatusTone, jobTypeLabel } from '$lib/shared/jobstyle';

	let {
		job,
		oncancel,
		onretry,
	}: {
		job: JobDTO;
		oncancel?: (id: string) => void;
		onretry?: (id: string) => void;
	} = $props();

	const typeLabel = jobTypeLabel;
	const statusTone = jobStatusTone;

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
			{#if job.finishedAt}
				· finished {formatRelativeTime(job.finishedAt)}
			{:else if job.status === 'running'}
				· started {formatRelativeTime(job.startedAt ?? job.createdAt)}
			{:else}
				· {job.status === 'queued' ? 'queued' : 'seen'}
				{formatRelativeTime(job.createdAt)}
			{/if}
		</p>
		{#if job.status === 'running' || (job.status === 'queued' && job.progress > 0)}
			<div class="mt-2 flex items-center gap-2">
				<div
					class="m3-progress min-w-0 flex-1"
					role="progressbar"
					aria-valuenow={job.progress}
					aria-valuemin="0"
					aria-valuemax="100"
					aria-label={`Job progress: ${job.progress} of 100`}
				>
					<div class="bar" style:width="{job.progress}%"></div>
				</div>
				<span class="shrink-0 text-xs tabular-nums text-on-surface-variant"
					>{job.progress} / 100</span
				>
			</div>
		{/if}
	</div>
	<div class="flex gap-2">
		{#if cancellable}
			<button
				type="button"
				class="m3-btn m3-btn-text text-sm"
				onclick={() => oncancel?.(job.id)}>Cancel</button
			>
		{/if}
		{#if retryable}
			<button
				type="button"
				class="m3-btn m3-btn-text text-sm"
				onclick={() => onretry?.(job.id)}>Retry</button
			>
		{/if}
	</div>
</div>
