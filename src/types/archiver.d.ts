declare module 'archiver' {
	import type { Transform } from 'node:stream';

	export interface ArchiverOptions {
		zlib?: { level?: number };
		gzip?: boolean;
		[key: string]: unknown;
	}

	export declare class Archiver extends Transform {
		append(
			source: NodeJS.ReadableStream | Buffer | string,
			options?: { name: string; size?: number; date?: Date | string },
		): this;
		finalize(): Promise<void> | void;
		abort(): boolean;
		pointer(): number;
		on(event: 'error', listener: (err: Error) => void): this;
		on(event: 'warning', listener: (err: Error) => void): this;
		on(event: 'entry', listener: (entry: { name: string }) => void): this;
		on(event: string, listener: (...args: unknown[]) => void): this;
	}

	export class ZipArchive extends Archiver {
		constructor(options?: ArchiverOptions);
	}
	export class TarArchive extends Archiver {
		constructor(options?: ArchiverOptions);
	}
}
