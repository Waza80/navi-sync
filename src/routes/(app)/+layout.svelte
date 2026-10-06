<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { HugeiconsIcon } from '@hugeicons/svelte';
	import {
		ElectricPlugsIcon,
		ListMusicIcon,
		Satellite01Icon,
		Settings01Icon,
	} from '@hugeicons/core-free-icons';
	import { resolve } from '$app/paths';
	import { authClient } from '$lib/client/auth';
	import { live } from '$lib/stores/events.svelte';
	import { APP_VERSION_SHORT } from '$lib/version';
	import { onMount } from 'svelte';

	// Open the SSE stream. Nothing in the app was ever calling live.start(), so the
	// EventSource was never created: the queue rendered its SSR snapshot and then sat
	// frozen. `live.connected` was referenced on the dashboard, which made it look
	// wired up while no events could arrive. Started here, in the layout, so every
	// authenticated page shares one connection and it closes on navigation away.
	onMount(() => {
		live.start();
		return () => live.stop();
	});

	let {
		children,
		data,
	}: {
		children: Snippet;
		data: { user: { email: string } };
	} = $props();

	const nav = [
		{ href: '/dashboard', label: 'Library', icon: ListMusicIcon },
		{ href: '/providers', label: 'Providers', icon: ElectricPlugsIcon },
		{ href: '/settings', label: 'Settings', icon: Settings01Icon },
	] as const;

	const resolvedNav = $derived(
		nav.map((item) => ({ ...item, resolvedHref: resolve(item.href) })),
	);

	async function signOut() {
		await authClient.signOut();
		await goto(resolve('/login'));
	}
</script>

<svelte:head>
	<title>NaviSync</title>
</svelte:head>

<a
	href="#main"
	class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-primary focus:px-4 focus:py-2 focus:text-on-primary"
>
	Skip to content
</a>

<div class="flex min-h-dvh flex-col">
	<!-- Top app bar -->
	<header
		class="sticky top-0 z-40 border-b border-outline-variant/40 bg-surface-low/95 backdrop-blur"
	>
		<div class="mx-auto flex h-16 max-w-5xl items-center gap-4 px-4">
			<a
				href={resolve('/dashboard')}
				class="flex items-center gap-2 font-semibold tracking-tight"
			>
				<span aria-hidden="true" class="text-xl text-primary"
					><HugeiconsIcon icon={Satellite01Icon} size={22} strokeWidth={1.5} /></span
				>
				<span>NaviSync</span>
				<!-- Bump APP_VERSION in src/lib/version.ts on every release. -->
				<span
					class="rounded-full bg-surface-highest px-2 py-0.5 font-mono text-[11px] font-medium text-on-surface-variant"
					title={`NaviSync ${APP_VERSION_SHORT}`}>{APP_VERSION_SHORT}</span
				>
			</a>
			<nav class="ml-6 hidden gap-1 sm:flex" aria-label="Primary">
				{#each resolvedNav as item (item.href)}
					<a
						href={item.resolvedHref}
						aria-current={page.url.pathname === item.href ? 'page' : undefined}
						class="rounded-full px-4 py-2 text-sm {page.url.pathname === item.href
							? 'bg-secondary-container text-on-secondary-container'
							: 'text-on-surface-variant hover:bg-surface-highest'}"
					>
						{item.label}
					</a>
				{/each}
			</nav>
			<div class="ml-auto flex items-center gap-2">
				<span class="hidden text-xs text-on-surface-variant md:inline"
					>{data.user.email}</span
				>
				<button
					type="button"
					class="m3-btn m3-btn-tonal h-10 min-h-10 px-4 text-sm"
					onclick={signOut}
				>
					Sign out
				</button>
			</div>
		</div>
	</header>

	<main id="main" class="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 pb-28 sm:pb-10">
		{@render children()}
	</main>

	<!-- Bottom navigation (mobile-first, ≥48px targets) -->
	<nav
		class="fixed inset-x-0 bottom-0 z-40 flex border-t border-outline-variant/40 bg-surface-low/95 backdrop-blur sm:hidden"
		aria-label="Primary mobile"
	>
		{#each resolvedNav as item (item.href)}
			<a
				href={item.resolvedHref}
				aria-current={page.url.pathname === item.href ? 'page' : undefined}
				class="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs {page
					.url.pathname === item.href
					? 'text-primary'
					: 'text-on-surface-variant'}"
			>
				<span aria-hidden="true" class="text-lg text-on-surface-variant"
					><HugeiconsIcon icon={item.icon} size={20} strokeWidth={1.5} /></span
				>
				{item.label}
			</a>
		{/each}
	</nav>
</div>
