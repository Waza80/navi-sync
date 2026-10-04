/** DTOs and event contracts shared between server routes and the browser. */

export type JobType = 'download' | 'lyrics' | 'navidrome_scan' | 'export';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';
export type LyricsStatus = 'none' | 'synced' | 'plain' | 'failed';

export interface TrackDTO {
	id: string;
	provider: string;
	title: string;
	artist: string;
	album: string | null;
	isrc: string | null;
	trackNumber: number | null;
	releaseYear: number | null;
	durationSec: number | null;
	format: string;
	bitrateKbps: number | null;
	bitDepth: number | null;
	sampleRateHz: number | null;
	isLossless: boolean;
	sizeBytes: number | null;
	lyricsStatus: LyricsStatus;
	createdAt: string;
}

export interface JobDTO {
	id: string;
	type: JobType;
	status: JobStatus;
	priority: number;
	progress: number;
	stage: string | null;
	error: string | null;
	attempts: number;
	maxAttempts: number;
	trackId: string | null;
	createdAt: string;
	finishedAt: string | null;
}

/** Real-time events broadcast on the `navi_events` NOTIFY channel (ADR-0002). */
export type NaviEvent =
	| { type: 'job.queued'; jobId: string; jobType: JobType; trackId: string | null; ts: string }
	| {
			type: 'job.progress';
			jobId: string;
			jobType: JobType;
			trackId: string | null;
			progress: number;
			stage: string | null;
			ts: string;
	  }
	| {
			type: 'job.completed';
			jobId: string;
			jobType: JobType;
			trackId: string | null;
			result?: Record<string, unknown> | null;
			ts: string;
	  }
	| {
			type: 'job.failed';
			jobId: string;
			jobType: JobType;
			trackId: string | null;
			error: string | null;
			willRetry: boolean;
			ts: string;
	  }
	| { type: 'job.cancelled'; jobId: string; jobType: JobType; ts: string };

export function isNaviEvent(value: unknown): value is NaviEvent {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v['type'] === 'string' &&
		['job.queued', 'job.progress', 'job.completed', 'job.failed', 'job.cancelled'].includes(
			v['type'],
		)
	);
}
