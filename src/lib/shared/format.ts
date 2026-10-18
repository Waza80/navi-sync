/** Pure display formatters (unit-tested). */

export function formatDuration(totalSeconds: number | null | undefined): string {
	if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
		return '—';
	}
	const s = Math.max(0, Math.round(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
	return `${m}:${String(sec).padStart(2, '0')}`;
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const digits = unit === 0 ? 0 : 1;
	return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * `44.1 kHz`, `96 kHz`, `192 kHz` — or null when the rate was never recorded.
 *
 * 44.1 is spelled that way because that is how it is written on every sleeve and
 * spec sheet; the rest are round numbers. `44,100` in a chip looks like a bug.
 */
export function sampleRateLabel(hz: number | null | undefined): string | null {
	if (hz == null || !Number.isFinite(hz) || hz <= 0) return null;
	return `${Number((hz / 1000).toFixed(1))} kHz`;
}

/**
 * The quality chip on a track card, e.g. `FLAC 24-bit · 96 kHz` or `HI-RES 96 kHz`.
 *
 * A hi-res file says HI-RES *instead of* the depth, not in a chip of its own. As a
 * third chip it pushed the lyrics badge off the row and left the card looking
 * cluttered; the depth is also the less useful half of the two — "24-bit" on its
 * own no longer distinguishes a 24/44.1 file from a 24/192 one, while HI-RES does
 * and keeps the rate visible.
 *
 * Below hi-res the rate is still omitted at CD rate, where it says nothing: the
 * chip appears on every track in the library, and "FLAC 16-bit · 44.1 kHz" is
 * noise.
 *
 * An unknown rate prints nothing rather than guessing — the chip must not claim a
 * tier the library cannot back.
 */
export function qualityLabel(
	format: string,
	bitrateKbps: number | null,
	bitDepth: number | null,
	sampleRateHz?: number | null,
): string {
	if (format === 'flac') {
		const depth = bitDepth ?? 16;
		const rate = sampleRateHz ?? null;
		const isHiRes = depth >= 24 && (rate ?? 0) > 48_000;
		if (isHiRes) return rate ? `HI-RES ${sampleRateLabel(rate)}` : 'HI-RES';
		return `FLAC ${depth}-bit`;
	}
	if (format === 'mp3') return `MP3 ${bitrateKbps ?? '?'}k`;
	return format.toUpperCase();
}
