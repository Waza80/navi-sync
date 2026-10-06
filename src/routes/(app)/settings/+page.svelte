<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	type PublicSettings = {
		navidromeUrl: string | null;
		navidromeUsername: string | null;
		hasNavidromePassword: boolean;
		libraryPath: string;
		minBitrateKbps: number;
		preferLossless: boolean;
		allowLowerFallback: boolean;
		autoUpgradeQuality: boolean;
		forceTagRepair: boolean;
		enabledProviders: string[];
		concurrentDownloads: number;
	};

	let { data }: { data: { settings: PublicSettings } } = $props();

	// Form state is initialized synchronously from the server snapshot.
	// (A previous $effect.pre init assigned state declared later in the file,
	// which crashed hydration with a temporal-dead-zone ReferenceError.)
	// svelte-ignore state_referenced_locally
	let navidromeUrl = $state(data.settings.navidromeUrl ?? '');
	// svelte-ignore state_referenced_locally
	let navidromeUsername = $state(data.settings.navidromeUsername ?? '');
	let navidromePassword = $state('');
	// svelte-ignore state_referenced_locally
	let minBitrateKbps = $state(data.settings.minBitrateKbps);
	// svelte-ignore state_referenced_locally
	let preferLossless = $state(data.settings.preferLossless);
	// svelte-ignore state_referenced_locally
	let allowLowerFallback = $state(data.settings.allowLowerFallback);
	// svelte-ignore state_referenced_locally
	let autoUpgradeQuality = $state(data.settings.autoUpgradeQuality);
	// svelte-ignore state_referenced_locally
	let forceTagRepair = $state(data.settings.forceTagRepair);
	// svelte-ignore state_referenced_locally
	let concurrentDownloads = $state(data.settings.concurrentDownloads);

	// svelte-ignore state_referenced_locally
	let enabled = $state<string[]>([...data.settings.enabledProviders]);

	let message = $state<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
	let busy = $state(false);
	let pingBusy = $state(false);
	let scanBusy = $state(false);
	let repairBusy = $state(false);

	// Enabled providers (local working copy; persisted via Save settings)
	let aliveBusy: Record<string, boolean> = $state({});
	let aliveResult: { id: string; ok: boolean; text: string } | null = $state(null);

	function toggleProvider(id: string, on: boolean) {
		enabled = on ? [...new Set([...enabled, id])] : enabled.filter((x) => x !== id);
	}

	async function checkAlive(id: string) {
		aliveBusy[id] = true;
		aliveResult = null;
		try {
			const res = await fetch(`/api/providers/${id}/test`, { method: 'POST' });
			const body = (await res.json()) as { ok?: boolean; detail?: string };
			aliveResult = {
				id,
				ok: Boolean(body.ok),
				text: body.ok ? (body.detail ?? 'alive') : (body.detail ?? 'unreachable'),
			};
		} catch {
			aliveResult = { id, ok: false, text: 'network error' };
		} finally {
			aliveBusy[id] = false;
		}
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		message = null;
		busy = true;
		try {
			// Partial-save semantics: blank URL/username are ignored (never wipe a
			// saved value by leaving a field empty); password only when typed.
			const payload: Record<string, unknown> = {
				minBitrateKbps,
				preferLossless,
				allowLowerFallback,
				autoUpgradeQuality,
				forceTagRepair,
				enabledProviders: enabled.length > 0 ? enabled : ['deezer'],
				concurrentDownloads,
			};
			if (navidromeUrl.trim().length > 0) payload.navidromeUrl = navidromeUrl.trim();
			if (navidromeUsername.trim().length > 0)
				payload.navidromeUsername = navidromeUsername.trim();
			if (navidromePassword.length > 0) payload.navidromePassword = navidromePassword;
			const res = await fetch('/api/navidrome', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const body = (await res.json()) as { error?: { message: string } };
			if (!res.ok) {
				message = { tone: 'error', text: body.error?.message ?? `HTTP ${res.status}` };
				return;
			}
			navidromePassword = '';
			message = { tone: 'ok', text: 'Settings saved.' };
			await invalidateAll();
		} finally {
			busy = false;
		}
	}

	async function testConnection() {
		message = null;
		pingBusy = true;
		try {
			const res = await fetch('/api/navidrome/scan', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ pingOnly: true }),
			});
			const body = (await res.json()) as {
				ok?: boolean;
				serverVersion?: string;
				error?: string;
			};
			message = body.ok
				? {
						tone: 'ok',
						text: `Connected. Server version: ${body.serverVersion ?? 'unknown'}`,
					}
				: { tone: 'error', text: `Connection failed: ${body.error ?? 'unknown error'}` };
		} finally {
			pingBusy = false;
		}
	}

	async function triggerScan() {
		message = null;
		scanBusy = true;
		try {
			const res = await fetch('/api/navidrome/scan', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			});
			const body = (await res.json()) as { error?: { message: string } };
			message = res.ok
				? { tone: 'ok', text: 'Scan queued — watch the queue on the Library page.' }
				: { tone: 'error', text: body.error?.message ?? `HTTP ${res.status}` };
		} finally {
			scanBusy = false;
		}
	}

	async function repairIndexation() {
		message = null;
		repairBusy = true;
		try {
			const res = await fetch('/api/navidrome/repair', { method: 'POST' });
			const body = (await res.json()) as {
				filesOnDisk?: number;
				tracksInDb?: number;
				serverVersion?: string;
				unindexedFiles?: number;
				unindexedSample?: string[];
				error?: { message: string };
			};
			if (!res.ok) {
				message = { tone: 'error', text: body.error?.message ?? `HTTP ${res.status}` };
				return;
			}
			// Say what did NOT reconcile. Reporting only the successes made a repair
			// that found 13 unaccounted files look identical to one that found nothing.
			const unaccounted = body.unindexedFiles ?? 0;
			const gap =
				unaccounted > 0
					? ` ${unaccounted} file(s) on disk have no index row — run scripts/reconcile-library.ts to adopt them.`
					: '';
			message = {
				tone: unaccounted > 0 ? 'warn' : 'ok',
				text:
					`Repair started — ${body.filesOnDisk ?? '?'} files on disk, ${body.tracksInDb ?? '?'} tracks in DB ` +
					`(Navidrome ${body.serverVersion ?? '?'}).${gap} Watch the queue; the job reports when indexing finishes.`,
			};
		} finally {
			repairBusy = false;
		}
	}
</script>

<svelte:head>
	<title>Settings — NaviSync</title>
</svelte:head>

<h1 class="mb-1 text-xl font-semibold">Settings</h1>
<p class="mb-6 text-sm text-on-surface-variant">
	Navidrome connection, quality guardrails and engine limits. Secrets are encrypted at rest.
</p>

<form onsubmit={save} class="flex flex-col gap-6">
	<!-- Navidrome -->
	<section class="m3-card p-5" aria-labelledby="navidrome-h">
		<h2 id="navidrome-h" class="mb-4 text-base font-medium">Navidrome</h2>
		<div class="flex flex-col gap-4">
			<div>
				<label for="nd-url" class="mb-1 block text-sm text-on-surface-variant"
					>Server URL</label
				>
				<input
					id="nd-url"
					type="url"
					class="m3-input"
					placeholder="https://navi.example.com"
					bind:value={navidromeUrl}
				/>
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label for="nd-user" class="mb-1 block text-sm text-on-surface-variant"
						>Username</label
					>
					<input
						id="nd-user"
						type="text"
						class="m3-input"
						autocomplete="off"
						bind:value={navidromeUsername}
					/>
				</div>
				<div>
					<label for="nd-pass" class="mb-1 block text-sm text-on-surface-variant">
						Password {data.settings.hasNavidromePassword
							? '(saved — leave blank to keep)'
							: ''}
					</label>
					<input
						id="nd-pass"
						type="password"
						class="m3-input"
						autocomplete="new-password"
						placeholder={data.settings.hasNavidromePassword ? '••••••••' : ''}
						bind:value={navidromePassword}
					/>
				</div>
			</div>
			<div class="flex flex-wrap gap-2">
				<button
					type="button"
					class="m3-btn m3-btn-tonal"
					disabled={pingBusy}
					onclick={testConnection}
				>
					{pingBusy ? 'Testing…' : 'Test connection'}
				</button>
				<button
					type="button"
					class="m3-btn m3-btn-tonal"
					disabled={scanBusy}
					onclick={triggerScan}
				>
					{scanBusy ? 'Queueing…' : 'Trigger scan now'}
				</button>
				<button
					type="button"
					class="m3-btn m3-btn-tonal"
					disabled={repairBusy}
					onclick={repairIndexation}
				>
					{repairBusy ? 'Repairing…' : 'Repair indexation'}
				</button>
			</div>
		</div>
	</section>

	<!-- Enabled providers + alive checks -->
	<section class="m3-card p-5" aria-labelledby="providers-h">
		<h2 id="providers-h" class="mb-4 text-base font-medium">Providers</h2>
		<p class="mb-4 text-sm text-on-surface-variant">
			Turn providers on/off for search, downloads and quality upgrades. The upgrade sweep only
			hunts across <em>enabled</em> providers — with both on, the best quality always wins. Manage
			credentials on the Providers page.
		</p>
		<div class="flex flex-col gap-3">
			{#each [{ id: 'deezer', label: 'Deezer', desc: 'FLAC 16-bit · 320/128 MP3' }, { id: 'tidal', label: 'Tidal (hiFi instance)', desc: 'FLAC up to 24/192 — fastest option, needs your instance URL' }] as prov (prov.id)}
				<div class="flex min-h-14 items-center gap-3 rounded-xl bg-surface-low px-3">
					<label class="flex flex-1 cursor-pointer items-center gap-3">
						<input
							type="checkbox"
							class="h-5 w-5 accent-[var(--md-primary)]"
							checked={enabled.includes(prov.id)}
							onchange={(e) => toggleProvider(prov.id, e.currentTarget.checked)}
						/>
						<span>
							<span class="block text-sm font-medium">{prov.label}</span>
							<span class="block text-xs text-on-surface-variant">{prov.desc}</span>
						</span>
					</label>
					<span
						class="m3-chip {enabled.includes(prov.id)
							? 'bg-tertiary-container text-on-tertiary-container'
							: 'bg-surface-highest text-on-surface-variant'}"
					>
						{enabled.includes(prov.id) ? 'ON' : 'OFF'}
					</span>
					<button
						type="button"
						class="m3-btn m3-btn-tonal h-10 min-h-10 px-3 text-xs"
						disabled={!enabled.includes(prov.id) || aliveBusy[prov.id]}
						onclick={() => checkAlive(prov.id)}
					>
						{aliveBusy[prov.id] ? 'Checking…' : 'Check alive'}
					</button>
				</div>
			{/each}
			{#if aliveResult}
				<p
					class="rounded-lg px-3 py-2 text-sm {aliveResult.ok
						? 'bg-tertiary-container text-on-tertiary-container'
						: 'bg-error-container text-on-error-container'}"
					role="status"
				>
					{aliveResult.id}: {aliveResult.text}
				</p>
			{/if}
		</div>
	</section>

	<!-- Quality guardrails -->
	<section class="m3-card p-5" aria-labelledby="quality-h">
		<h2 id="quality-h" class="mb-4 text-base font-medium">Quality guardrails</h2>
		<div class="flex flex-col gap-4">
			<div>
				<label for="q-min" class="mb-1 block text-sm text-on-surface-variant">
					Minimum acceptable bitrate (lossy tiers)
				</label>
				<select id="q-min" class="m3-input" bind:value={minBitrateKbps}>
					<option value={128}>128 kbps (preview tier)</option>
					<option value={192}>192 kbps</option>
					<option value={320}>320 kbps (spec default)</option>
				</select>
			</div>
			<label class="flex min-h-12 items-center gap-3">
				<input
					type="checkbox"
					class="h-5 w-5 accent-[var(--md-primary)]"
					bind:checked={preferLossless}
				/>
				<span class="text-sm"
					>Prefer lossless (FLAC). Hard ceiling: 24-bit — never fetches above or
					re-fetches below.</span
				>
			</label>
			<label class="flex min-h-12 items-center gap-3">
				<input
					type="checkbox"
					class="h-5 w-5 accent-[var(--md-primary)]"
					bind:checked={allowLowerFallback}
				/>
				<span class="text-sm"
					>Allow lower-quality fallback when the preferred tier is unavailable for the
					account</span
				>
			</label>
			<label class="flex min-h-12 items-center gap-3">
				<input
					type="checkbox"
					class="h-5 w-5 accent-[var(--md-primary)]"
					bind:checked={autoUpgradeQuality}
				/>
				<span class="text-sm">
					Keep hunting for better masters (hourly, up to 24-bit).
					<span class="text-on-surface-variant">
						Turning this off stops only the upgrade sweep — missing songs are still
						fetched.
					</span>
				</span>
			</label>
		</div>
	</section>

	<!--
		Maintenance actions, kept OUT of the preferences sections on purpose. This is
		not a standing preference like "prefer lossless" — it is a one-shot override
		for the next repair pass, and leaving it sitting among the download settings
		invites the question "what does this actually affect?" with no good answer.
	-->
	<section class="m3-card p-5" aria-labelledby="maint-h">
		<h2 id="maint-h" class="mb-1 text-base font-medium">Maintenance</h2>
		<p class="mb-3 text-sm text-on-surface-variant">
			One-shot overrides for the next repair run. They are saved, so they stay in effect until
			you turn them off.
		</p>
		<label class="flex min-h-12 items-center gap-3">
			<input
				type="checkbox"
				class="h-5 w-5 accent-[var(--md-primary)]"
				bind:checked={forceTagRepair}
			/>
			<span class="text-sm">
				Re-write tags on every file during repair
				<span class="block text-xs text-on-surface-variant">
					Normally only files with missing or broken tags are touched.
				</span>
			</span>
		</label>
	</section>

	<!-- Engine -->
	<section class="m3-card p-5" aria-labelledby="engine-h">
		<h2 id="engine-h" class="mb-4 text-base font-medium">Download engine</h2>
		<div>
			<label for="eng-conc" class="mb-1 block text-sm text-on-surface-variant">
				Concurrent downloads: <strong>{concurrentDownloads}</strong>
			</label>
			<input
				id="eng-conc"
				type="range"
				min="1"
				max="8"
				step="1"
				class="w-full accent-[var(--md-primary)]"
				bind:value={concurrentDownloads}
			/>
		</div>
		<p class="mt-2 text-xs text-on-surface-variant">
			Library root on disk: <code class="text-on-surface">{data.settings.libraryPath}</code>
		</p>
	</section>

	{#if message}
		<p
			class="rounded-lg px-3 py-2 text-sm {message.tone === 'ok'
				? 'bg-tertiary-container text-on-tertiary-container'
				: message.tone === 'warn'
					? 'bg-secondary-container text-on-secondary-container'
					: 'bg-error-container text-on-error-container'}"
			role="status"
		>
			{message.text}
		</p>
	{/if}

	<!-- Sticky save bar: always visible, no scrolling, no Enter needed -->
	<div
		class="sticky bottom-20 z-30 -mx-1 mt-2 rounded-2xl border border-outline-variant/40 bg-surface-low/95 p-3 backdrop-blur sm:bottom-2"
	>
		<div class="flex items-center gap-3 px-1">
			<button type="submit" class="m3-btn m3-btn-filled" disabled={busy}>
				{busy ? 'Saving…' : 'Save settings'}
			</button>
			<span class="text-xs text-on-surface-variant"
				>Changes apply to new downloads immediately.</span
			>
		</div>
	</div>
</form>
