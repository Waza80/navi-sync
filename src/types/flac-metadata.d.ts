declare module 'flac-metadata' {
	import type { Transform } from 'node:stream';

	export interface MetaDataBlock {
		type: number;
		isLast: boolean;
		/** Set true in a preprocess handler to drop this block. */
		removed?: boolean;
	}

	export interface MetaDataBlockVorbisComment extends MetaDataBlock {
		vendor: string;
		/** Each entry: "KEY=VALUE". */
		comments: string[];
	}

	export interface MetaDataBlockPicture extends MetaDataBlock {
		pictureType: number;
		mime: string;
		description: string;
		width: number;
		height: number;
		bitsPerPixel: number;
		colors: number | null;
		data: Buffer;
	}

	export class Processor extends Transform {
		static MDB_TYPE_STREAMINFO: number;
		static MDB_TYPE_PADDING: number;
		static MDB_TYPE_APPLICATION: number;
		static MDB_TYPE_SEEKTABLE: number;
		static MDB_TYPE_VORBIS_COMMENT: number;
		static MDB_TYPE_CUESHEET: number;
		static MDB_TYPE_PICTURE: number;
		static MDB_TYPE_INVALID: number;
		constructor(options?: { parseMetaDataBlocks?: boolean });
		/** Emitted for each metadata block before it is written back. */
		on(event: 'preprocess', listener: (mdb: MetaDataBlock) => void): this;
		on(event: 'postprocess', listener: (mdb: MetaDataBlock) => void): this;
		on(event: string, listener: (...args: unknown[]) => void): this;
	}

	export const data: {
		MetaDataBlock: { new (): MetaDataBlock };
		MetaDataBlockStreamInfo: { new (): MetaDataBlock };
		MetaDataBlockVorbisComment: {
			create(isLast: boolean, vendor: string, comments: string[]): MetaDataBlockVorbisComment;
		};
		MetaDataBlockPicture: {
			create(
				isLast: boolean,
				pictureType: number,
				mime: string,
				description: string,
				width: number,
				height: number,
				bitsPerPixel: number,
				colors: number | null,
				pictureData: Buffer,
			): MetaDataBlockPicture;
		};
	};
}
