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

export function qualityLabel(
	format: string,
	bitrateKbps: number | null,
	bitDepth: number | null,
): string {
	if (format === 'flac') {
		const depth = bitDepth ?? 16;
		return `FLAC ${depth}-bit`;
	}
	if (format === 'mp3') return `MP3 ${bitrateKbps ?? '?'}k`;
	return format.toUpperCase();
}
