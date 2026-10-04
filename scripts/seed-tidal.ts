/**
 * One-off: point the Tidal provider at a hiFi instance on the local dev DB.
 * Usage: TIDAL_INSTANCE_URL=https://hifi.example.com bun scripts/seed-tidal.ts
 */
import { getProviderConfig, setProviderConfig } from '../src/lib/server/providers/config';

const url = process.env.TIDAL_INSTANCE_URL;
if (!url) {
	console.error('Set TIDAL_INSTANCE_URL to your hiFi instance base URL.');
	process.exit(1);
}
await setProviderConfig('tidal', { instanceUrl: url, quality: 'HI_RES_LOSSLESS' });
const back = await getProviderConfig<{ instanceUrl: string; quality: string }>('tidal');
if (back?.instanceUrl !== url) {
	console.error('Config round-trip mismatch — aborting.');
	process.exit(1);
}
console.log(`✓ tidal configured: ${back.instanceUrl} (${back.quality})`);
