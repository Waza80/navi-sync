import { appendFileSync, statSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '$lib/server/env';

/**
 * Structured JSON logger — local-only by design:
 *  - writes JSON lines to stdout (captured/rotated by Docker log driver), and
 *  - optionally to ./logs/navisync.log with naive size rotation (5 MB × 3).
 * GDPR rules enforced here:
 *  - values of sensitive keys are replaced with "[REDACTED]" before serialization
 *  - no external transports exist; nothing ever leaves the machine.
 */

const SENSITIVE_KEY =
	/(password|pass|token|secret|arl|authorization|cookie|jwt|credential|apikey|api_key|email)/i;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const activeLevel: number =
	LEVELS[(env.LOG_LEVEL as Level) in LEVELS ? (env.LOG_LEVEL as Level) : 'info'];

function redact(meta: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(meta)) {
		if (SENSITIVE_KEY.test(key)) {
			out[key] = '[REDACTED]';
		} else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
			out[key] = redact(value as Record<string, unknown>);
		} else {
			out[key] = value;
		}
	}
	return out;
}

const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../logs');
const LOG_FILE = join(LOG_DIR, 'navisync.log');
const ROTATE_SIZE = 5 * 1024 * 1024;
const ROTATE_KEEP = 3;

function writeToFile(line: string): void {
	try {
		if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
		if (existsSync(LOG_FILE)) {
			const { size } = statSync(LOG_FILE);
			if (size > ROTATE_SIZE) {
				for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
					const from = `${LOG_FILE}.${i}`;
					const to = `${LOG_FILE}.${i + 1}`;
					if (existsSync(from)) renameSync(from, to);
				}
				renameSync(LOG_FILE, `${LOG_FILE}.1`);
			}
		}
		appendFileSync(LOG_FILE, line + '\n');
	} catch {
		// File logging must never take the app down; stdout is the source of truth.
	}
}

function log(level: Level, msg: string, meta: Record<string, unknown> = {}): void {
	if (LEVELS[level] < activeLevel) return;
	const entry = { ts: new Date().toISOString(), level, msg, ...redact(meta) };
	const line = JSON.stringify(entry);
	// Justified: this module IS the logging gateway; nothing else may use console.
	// eslint-disable-next-line no-console
	if (level === 'error') console.error(line);
	// eslint-disable-next-line no-console
	else console.log(line);
	writeToFile(line);
}

export interface Logger {
	debug(msg: string, meta?: Record<string, unknown>): void;
	info(msg: string, meta?: Record<string, unknown>): void;
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, meta?: Record<string, unknown>): void;
}

export function childLogger(module: string): Logger {
	return {
		debug: (msg, meta) => log('debug', msg, { module, ...meta }),
		info: (msg, meta) => log('info', msg, { module, ...meta }),
		warn: (msg, meta) => log('warn', msg, { module, ...meta }),
		error: (msg, meta) => log('error', msg, { module, ...meta }),
	};
}

export const logger: Logger = childLogger('app');
