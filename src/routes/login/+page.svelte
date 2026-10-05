<script lang="ts">
	import { authClient } from '$lib/client/auth';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { HugeiconsIcon } from '@hugeicons/svelte';
	import { Satellite01Icon } from '@hugeicons/core-free-icons';

	let mode = $state<'signin' | 'signup'>('signin');
	let email = $state('');
	let password = $state('');
	let name = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		busy = true;
		try {
			if (mode === 'signup') {
				const res = await authClient.signUp.email({
					name: name.trim() || email.split('@')[0],
					email: email.trim(),
					password,
				});
				if (res.error) {
					error = res.error.message ?? 'Sign-up failed.';
					return;
				}
			} else {
				const res = await authClient.signIn.email({ email: email.trim(), password });
				if (res.error) {
					error = res.error.message ?? 'Sign-in failed.';
					return;
				}
			}
			await goto(resolve('/dashboard'));
		} catch {
			error = 'Network error — is the server reachable?';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>NaviSync — Sign in</title>
	<meta name="description" content="NaviSync — self-hosted Navidrome companion" />
</svelte:head>

<main id="main" class="flex min-h-dvh items-center justify-center p-4">
	<div class="w-full max-w-sm">
		<header class="mb-8 text-center">
			<div
				class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-container text-on-primary-container"
				aria-hidden="true"
			>
				<HugeiconsIcon icon={Satellite01Icon} size={30} strokeWidth={1.5} />
			</div>
			<h1 class="text-2xl font-semibold tracking-tight">NaviSync</h1>
			<p class="mt-1 text-sm text-on-surface-variant">Self-hosted Navidrome companion</p>
		</header>

		<div class="m3-card p-6">
			<div
				class="mb-6 flex rounded-full bg-surface-highest p-1"
				role="tablist"
				aria-label="Authentication mode"
			>
				<button
					type="button"
					role="tab"
					aria-selected={mode === 'signin'}
					class="m3-btn flex-1 text-sm {mode === 'signin'
						? 'm3-btn-filled'
						: 'm3-btn-text'}"
					onclick={() => (mode = 'signin')}>Sign in</button
				>
				<button
					type="button"
					role="tab"
					aria-selected={mode === 'signup'}
					class="m3-btn flex-1 text-sm {mode === 'signup'
						? 'm3-btn-filled'
						: 'm3-btn-text'}"
					onclick={() => (mode = 'signup')}>Create account</button
				>
			</div>

			<form onsubmit={submit} class="flex flex-col gap-4" novalidate>
				{#if mode === 'signup'}
					<div>
						<label for="name" class="mb-1 block text-sm text-on-surface-variant"
							>Name</label
						>
						<input
							id="name"
							name="name"
							type="text"
							class="m3-input"
							autocomplete="name"
							bind:value={name}
						/>
					</div>
				{/if}
				<div>
					<label for="email" class="mb-1 block text-sm text-on-surface-variant"
						>Email</label
					>
					<input
						id="email"
						name="email"
						type="email"
						class="m3-input"
						autocomplete="email"
						required
						bind:value={email}
					/>
				</div>
				<div>
					<label for="password" class="mb-1 block text-sm text-on-surface-variant">
						Password {#if mode === 'signup'}<span class="text-xs"
								>(min 10 characters)</span
							>{/if}
					</label>
					<input
						id="password"
						name="password"
						type="password"
						class="m3-input"
						autocomplete={mode === 'signup' ? 'new-password' : 'current-password'}
						minlength={mode === 'signup' ? 10 : undefined}
						required
						bind:value={password}
					/>
				</div>

				{#if error}
					<p
						class="rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
						role="alert"
					>
						{error}
					</p>
				{/if}

				<button type="submit" class="m3-btn m3-btn-filled w-full" disabled={busy}>
					{busy ? 'Working…' : mode === 'signup' ? 'Create account' : 'Sign in'}
				</button>
			</form>
		</div>

		<p class="mt-6 text-center text-xs text-on-surface-variant">
			Single-instance deployment · credentials stay on this server
		</p>
	</div>
</main>
