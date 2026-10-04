-- Rename the Monochrome provider to Tidal and reorder provider precedence.
--
-- The `monochrome` provider proxied tracks.monochrome.st, a Cloudflare-capped
-- instance that needed a chunked Range downloader and sustained ~28 KB/s. It is
-- replaced by `tidal`, backed by a self-hosted hiFi (hifi-api) instance that
-- serves true lossless up to 24/192 at multi-MB/s. No table changes shape —
-- only the provider identifier stored on existing rows, plus the default
-- ordering so Tidal is consulted before Deezer.
--
-- Backfill first so historical rows keep pointing at a provider that exists.
UPDATE tracks SET provider = 'tidal' WHERE provider = 'monochrome';
UPDATE jobs SET payload = jsonb_set(payload, '{provider}', '"tidal"'::jsonb)
	WHERE payload ? 'provider' AND payload->>'provider' = 'monochrome';

-- Stored provider config is left alone: the Monochrome URL is meaningless to
-- the hiFi client, and silently re-enabling a provider the user had turned off
-- would be worse than leaving the list for them to confirm in the Providers UI.
-- A provider named in enabledProviders but absent from the registry is inert:
-- enabledProviders() filters the registry by the enabled set, so an unknown id
-- simply matches nothing.

-- Default for any row that never existed or was left with an empty list, and
-- for fresh installs.
UPDATE settings
	SET enabled_providers = '["tidal","deezer"]'::jsonb
WHERE enabled_providers IS NULL OR jsonb_array_length(enabled_providers) = 0;

ALTER TABLE settings ALTER COLUMN enabled_providers SET DEFAULT '["tidal","deezer"]'::jsonb;