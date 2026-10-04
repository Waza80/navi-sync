<script lang="ts">
	let { label, value, hint }: { label: string; value: string | number; hint?: string } = $props();
</script>

<div class="m3-card flex flex-col gap-1 p-4">
	<span class="text-xs font-medium tracking-wide text-on-surface-variant uppercase">{label}</span>
	<span class="text-2xl font-semibold">{value}</span>
	{#if hint}
		<span class="text-xs text-on-surface-variant">{hint}</span>
	{/if}
</div>
