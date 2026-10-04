-- Add the auto_upgrade_quality setting.
--
-- When false, the cross-provider quality-upgrade sweep stops looking for better
-- masters of tracks that already exist. Deliberately does NOT affect the
-- failed-download retry sweep: a missing song must still be fetched.
--
-- Default true preserves existing behaviour.

ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_upgrade_quality boolean NOT NULL DEFAULT true;