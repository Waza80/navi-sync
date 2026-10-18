-- Hi-res lossless: sample rate is a quality tier, and the upgrade sweep needs to
-- remember what it has already looked at.
--
-- 1. Deezer serves a `FLAC_24` tier that is 24-bit ABOVE CD rate (verified live
--    2026-10: Pink Floyd - Money, 96 kHz, 134.7 MiB against 40.3 MiB for the CD
--    master). The client never asked for it, so every hi-res master on Deezer was
--    being fetched at 16/44.1.
--
-- 2. Because 24-bit is no longer one tier, the sweep's candidate query has to
--    consider 24-bit rows below hi-res. That filter lives in SQL
--    (listUpgradeCandidates), so no column is needed for it — but the sweep's
--    ORDER BY does need to know which rows it has already examined, otherwise the
--    widened candidate set starves: the same rows are re-picked every hour and the
--    backlog behind them never advances.

ALTER TABLE tracks ADD COLUMN IF NOT EXISTS upgrade_checked_at timestamp;

-- Fetch hi-res masters when a provider has one. Deezer's `FLAC_24` tier and
-- Tidal's 24/192 both exist now, and declining hi-res has to leave CD-quality
-- lossless available — which is why this is its own flag rather than a
-- consequence of prefer_lossless.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS prefer_hi_res boolean NOT NULL DEFAULT true;

-- The sweep selects unexamined rows first, and treats examined ones last.
CREATE INDEX IF NOT EXISTS tracks_upgrade_sweep_idx
  ON tracks (upgrade_checked_at, created_at)
  WHERE file_path IS NOT NULL;