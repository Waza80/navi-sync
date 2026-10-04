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
		concurrentDownloads: number;
	};

	let { data }: { data: { settings: PublicSettings } } = $props();

	let navidromeUrl = $state('');
	let navidromeUsername = $state('');
	let navidromePassword = $state('');
	let minBitrateKbps = $state(320);
	let preferLossless = $state(true);
	let allowLowerFallback = $state(true);
	let concurrentDownloads = $state(4);

	// Initialize the form from the first server snapshot (reactive context —
	// avoids capturing stale values at component construction).
	let initialized = false;
	$effect.pre(() => {
		if (initialized) return;
		initialized = true;
		navidromeUrl = data.settings.navidromeUrl ?? '';
		navidromeUsername = data.settings.navidromeUsername ?? '';
		minBitrateKbps = data.settings.minBitrateKbps;
		preferLossless = data.settings.preferLossless;
		allowLowerFallback = data.settings.allowLowerFallback;
		concurrentDownloads = data.settings.concurrentDownloads;
	});

	let message = $state<{ tone: 'ok' | 'error'; text: string } | null>(null);
	let busy = $state(false);
	let pingBusy = $state(false);
	let scanBusy = $state(false);

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
				concurrentDownloads
			};
			if (navidromeUrl.trim().length > 0) payload.navidromeUrl = navidromeUrl.trim();
			if (navidromeUsername.trim().length > 0) payload.navidromeUsername = navidromeUsername.trim();
			if (navidromePassword.length > 0) payload.navidromePassword = navidromePassword;
			const res = await fetch('/api/navidrome', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload)
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
				body: JSON.stringify({ pingOnly: true })
			});
			const body = (await res.json()) as { ok?: boolean; serverVersion?: string; error?: string };
			message = body.ok
				? { tone: 'ok', text: `Connected. Server version: ${body.serverVersion ?? 'unknown'}` }
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
				body: JSON.stringify({})
			});
			const body = (await res.json()) as { error?: { message: string } };
			message = res.ok
				? { tone: 'ok', text: 'Scan queued — watch the queue on the Library page.' }
				: { tone: 'error', text: body.error?.message ?? `HTTP ${res.status}` };
		} finally {
			scanBusy = false;
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
				<label for="nd-url" class="mb-1 block text-sm text-on-surface-variant">Server URL</label>
				<input id="nd-url" type="url" class="m3-input" placeholder="https://navi.example.com" bind:value={navidromeUrl} />
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label for="nd-user" class="mb-1 block text-sm text-on-surface-variant">Username</label>
					<input id="nd-user" type="text" class="m3-input" autocomplete="off" bind:value={navidromeUsername} />
				</div>
				<div>
					<label for="nd-pass" class="mb-1 block text-sm text-on-surface-variant">
						Password {data.settings.hasNavidromePassword ? '(saved — leave blank to keep)' : ''}
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
				<button type="button" class="m3-btn m3-btn-tonal" disabled={pingBusy} onclick={testConnection}>
					{pingBusy ? 'Testing…' : 'Test connection'}
				</button>
				<button type="button" class="m3-btn m3-btn-tonal" disabled={scanBusy} onclick={triggerScan}>
					{scanBusy ? 'Queueing…' : 'Trigger scan now'}
				</button>
			</div>
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
				<input type="checkbox" class="h-5 w-5 accent-[var(--md-primary)]" bind:checked={preferLossless} />
				<span class="text-sm">Prefer lossless (FLAC). Hard ceiling: 24-bit — never fetches above or re-fetches below.</span>
			</label>
			<label class="flex min-h-12 items-center gap-3">
				<input type="checkbox" class="h-5 w-5 accent-[var(--md-primary)]" bind:checked={allowLowerFallback} />
				<span class="text-sm">Allow lower-quality fallback when the preferred tier is unavailable for the account</span>
			</label>
		</div>
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
				: 'bg-error-container text-on-error-container'}"
			role="status"
		>
			{message.text}
		</p>
	{/if}

	<!-- Sticky save bar: always visible, no scrolling, no Enter needed -->
	<div class="sticky bottom-20 z-30 -mx-1 mt-2 rounded-2xl border border-outline-variant/40 bg-surface-low/95 p-3 backdrop-blur sm:bottom-2">
		<div class="flex items-center gap-3 px-1">
			<button type="submit" class="m3-btn m3-btn-filled" disabled={busy}>
				{busy ? 'Saving…' : 'Save settings'}
			</button>
			<span class="text-xs text-on-surface-variant">Changes apply to new downloads immediately.</span>
		</div>
	</div>
</form>
