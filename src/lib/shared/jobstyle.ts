/**
 * Shared queue presentation maps — one source for the job row AND the group
 * header. The dashboard groups rows by `type × status`, and a group header
 * styled differently from its rows would read as a different kind of thing.
 */

export const jobTypeLabel: Record<string, string> = {
	download: 'Download',
	lyrics: 'Lyrics',
	navidrome_scan: 'Navidrome scan',
	export: 'Export',
};

export const jobStatusTone: Record<string, string> = {
	queued: 'bg-secondary-container text-on-secondary-container',
	running: 'bg-primary-container text-on-primary-container',
	succeeded: 'bg-tertiary-container text-on-tertiary-container',
	failed: 'bg-error-container text-on-error-container',
	dead: 'bg-error-container text-on-error-container',
	cancelled: 'bg-surface-highest text-on-surface-variant',
};
