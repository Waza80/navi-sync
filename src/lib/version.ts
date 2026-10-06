/**
 * Build version, shown in the dashboard footer.
 *
 * Bump the patch component on every change you ship. Keep it a plain literal:
 * the value is inlined at build time, so the running container reports exactly
 * what was deployed with no runtime lookup.
 */
export const APP_VERSION = '0.6.0' as const;

/** Short form for tight spaces, e.g. `v0.4.0`. */
export const APP_VERSION_SHORT = `v${APP_VERSION}` as const;
