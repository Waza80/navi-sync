<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	interface Field {
		key: string;
		label: string;
		type: 'text' | 'password';
		required: boolean;
		placeholder?: string;
		help?: string;
	}
	interface ProviderInfo {
		id: string;
		displayName: string;
		description: string;
		fields: Field[];
		configured: boolean;
		via: 'ui' | 'env' | null;
		prefill: Record<string, string>;
	}

	let { data }: { data: { providers: ProviderInfo[] } } = $props();

	// Per-provider form state, initialized from the server snapshot.
	// Read the server snapshot inside a reactive context to avoid capturing a
	// stale `data` reference at construction (state_referenced_locally).
	let forms = $state<Record<string, Record<string, string>>>({});
	let initialized = false;
	$effect.pre(() => {
		if (initialized) return;
		initialized = true;
		forms = Object.fromEntries(
			data.providers.map((p) => [
				p.id,
				{ ...Object.fromEntries(p.fields.map((f) => [f.key, ''])), ...p.prefill }
			])
		);
	});
	let status = $state<Record<string, { tone: 'ok' | 'error' | 'info'; text: string } | null>>({});
	let busy = $state<Record<string, boolean>>({});

	async function save(p: ProviderInfo) {
		status[p.id] = null;
		busy[p.id] = true;
		try {
			// Only send filled fields (blank password = keep existing).
			const payload: Record<string, string> = {};
			for (const f of p.fields) {
				const v = (forms[p.id]?.[f.key] ?? '').trim();
				if (v.length > 0) payload[f.key] = v;
			}
			if (Object.keys(payload).length === 0) {
				status[p.id] = { tone: 'info', text: 'Nothing to save — fill at least one field.' };
				return;
			}
			const res = await fetch(`/api/providers/${p.id}/credentials`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload)
			});
			const body = (await res.json()) as { ok?: boolean; detail?: string; error?: string };
			if (res.ok && body.ok) {
				status[p.id] = { tone: 'ok', text: `Saved & verified — ${body.detail ?? 'ready'}` };
				await invalidateAll();
			} else {
				status[p.id] = { tone: 'error', text: body.error ?? `HTTP ${res.status}` };
			}
		} finally {
			busy[p.id] = false;
		}
	}

	async function clear(p: ProviderInfo) {
		busy[p.id] = true;
		try {
			await fetch(`/api/providers/${p.id}/credentials`, { method: 'DELETE' });
			status[p.id] = { tone: 'info', text: 'Credentials removed.' };
			for (const f of p.fields) forms[p.id][f.key] = '';
			await invalidateAll();
		} finally {
			busy[p.id] = false;
		}
	}
</script>

<svelte:head>
	<title>Providers — NaviSync</title>
</svelte:head>

<h1 class="mb-1 text-xl font-semibold">Providers</h1>
<p class="mb-6 text-sm text-on-surface-variant">
	Choose a provider, add its credentials, Save — values are encrypted at rest and never echoed back.
</p>

<div class="flex flex-col gap-6">
	{#each data.providers as p (p.id)}
		<section class="m3-card p-5" aria-labelledby={'prov-' + p.id}>
			<div class="mb-4 flex flex-wrap items-center gap-3">
				<h2 id={'prov-' + p.id} class="text-base font-medium">{p.displayName}</h2>
				{#if p.configured}
					<span class="m3-chip bg-tertiary-container text-on-tertiary-container">
						CONFIGURED{p.via === 'env' ? ' · via env' : ''}
					</span>
				{:else}
					<span class="m3-chip bg-surface-highest text-on-surface-variant">NOT CONFIGURED</span>
				{/if}
			</div>
			<p class="mb-4 text-sm text-on-surface-variant">{p.description}</p>

			<div class="flex flex-col gap-4">
				{#each p.fields as f (f.key)}
					<div>
						<label for={p.id + '-' + f.key} class="mb-1 block text-sm text-on-surface-variant">
							{f.label}{f.required ? '' : ' (optional)'}
						</label>
						<input
							id={p.id + '-' + f.key}
							type={f.type}
							class="m3-input"
							placeholder={f.placeholder}
							autocomplete="off"
							bind:value={forms[p.id][f.key]}
						/>
						{#if f.help}
							<p class="mt-1 text-xs text-on-surface-variant">{f.help}</p>
						{/if}
					</div>
				{/each}

					{#if status[p.id]}
					{@const st = status[p.id]!}
					<p
						class="rounded-lg px-3 py-2 text-sm {st.tone === 'ok'
							? 'bg-tertiary-container text-on-tertiary-container'
							: st.tone === 'error'
								? 'bg-error-container text-on-error-container'
								: 'bg-surface-highest text-on-surface-variant'}"
						role="status"
					>
						{st.text}
					</p>
				{/if}

				<div class="flex flex-wrap gap-2">
					<button type="button" class="m3-btn m3-btn-filled" disabled={busy[p.id]} onclick={() => save(p)}>
						{busy[p.id] ? 'Saving…' : 'Save & verify'}
					</button>
					{#if p.configured && p.via === 'ui'}
						<button type="button" class="m3-btn m3-btn-text text-error" disabled={busy[p.id]} onclick={() => clear(p)}>
							Remove stored credentials
						</button>
					{/if}
				</div>
			</div>
		</section>
	{/each}
</div>
