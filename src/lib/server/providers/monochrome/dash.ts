/**
 * Minimal DASH (MPD) manifest parsing for TIDAL-style audio manifests,
 * ported from the reference implementation (atvalerie/monodownload).
 * Regex-based on purpose: the manifests are small, machine-generated XML.
 *
 * Returns the segment URL list (initialization + media segments) for the
 * highest-bandwidth audio representation.
 */

export interface DashManifest {
	baseUrl: string;
	initialization: string | null;
	media: string | null;
	segments: Array<{ number: number; time: number }>;
	repId: string | null;
	mimeType: string | null;
	codecs: string | null;
	bandwidth: number;
}

/* ── tiny XML helpers (namespace-agnostic) ─────────────────────────────── */

function parseXmlAttributes(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([:\w-]+)=("([^"]*)"|'([^']*)')/gu;
	let m: RegExpExecArray | null;
	while ((m = re.exec(tag)) !== null) {
		attrs[m[1]] = (m[3] ?? m[4] ?? '').trim();
	}
	return attrs;
}

/** Splits `<Tag attrs>…body…</Tag>` occurrences (non-greedy, no nesting). */
function extractTagBlocks(xml: string, tag: string): Array<{ attrs: string; body: string }> {
	const out: Array<{ attrs: string; body: string }> = [];
	const re = new RegExp(`<(${tag}(?=[\\s>]))([^>]*)>([\\s\\S]*?)</\\1>`, 'gi');
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		out.push({ attrs: m[2] ?? '', body: m[3] ?? '' });
	}
	return out;
}

function extractFirstTagInner(xml: string, tag: string): string {
	const block = extractTagBlocks(xml, tag)[0];
	return block?.body ?? '';
}

function extractFirstTagText(xml: string, tag: string): string {
	const inner = extractFirstTagInner(xml, tag).trim();
	// strip possible CDATA / nested whitespace
	return inner.replace(/<!\[CDATA\[|\]\]>/gu, '').trim();
}

function extractFirstTagBlock(xml: string, tag: string): { attrs: string; body: string } | null {
	return extractTagBlocks(xml, tag)[0] ?? null;
}

function extractSelfClosingTags(xml: string, tag: string): Array<{ attrs: string }> {
	const out: Array<{ attrs: string }> = [];
	const re = new RegExp(`<(${tag}(?=[\\s/>]))([^>]*?)/?>`, 'gi');
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		out.push({ attrs: m[2] ?? '' });
	}
	return out;
}

function maxBandwidth(body: string): number {
	let max = 0;
	const re = /bandwidth="(\d+)"/gu;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) {
		max = Math.max(max, Number(m[1]));
	}
	return max;
}

export function decodeXmlEntities(input: string): string {
	return input
		.replace(/&amp;/gu, '&')
		.replace(/&lt;/gu, '<')
		.replace(/&gt;/gu, '>')
		.replace(/&quot;/gu, '"')
		.replace(/&apos;/gu, "'");
}

function deriveBaseUrlFromManifestUrl(manifestUrl: string | null): string {
	if (!manifestUrl) return '';
	const idx = manifestUrl.lastIndexOf('/');
	return idx > 0 ? manifestUrl.slice(0, idx + 1) : '';
}

/* ── main parser ───────────────────────────────────────────────────────── */

export function parseDashManifest(
	manifestText: string,
	manifestUrl: string | null = null,
): DashManifest {
	const xml = decodeXmlEntities(String(manifestText ?? ''));
	if (!xml.includes('<MPD')) throw new Error('Invalid DASH manifest');

	const mpdBaseUrl = extractFirstTagText(xml, 'BaseURL');
	const periodBody = extractFirstTagInner(xml, 'Period') || xml;
	const adaptationSets = extractTagBlocks(periodBody, 'AdaptationSet').map((block) => ({
		attrs: parseXmlAttributes(`<AdaptationSet${block.attrs}>`),
		body: block.body,
	}));
	if (adaptationSets.length === 0) throw new Error('No AdaptationSet found');

	adaptationSets.sort((a, b) => maxBandwidth(b.body) - maxBandwidth(a.body));
	const audioSet =
		adaptationSets.find((s) => (s.attrs['mimeType'] ?? '').toLowerCase().startsWith('audio')) ??
		adaptationSets[0];

	const representations = extractTagBlocks(audioSet.body, 'Representation')
		.map((block) => ({
			attrs: parseXmlAttributes(`<Representation${block.attrs}>`),
			body: block.body,
		}))
		.sort((a, b) => Number(b.attrs['bandwidth'] ?? 0) - Number(a.attrs['bandwidth'] ?? 0));
	if (representations.length === 0) throw new Error('No Representation found');

	const rep = representations[0];
	const segmentTemplateBlock =
		extractFirstTagBlock(rep.body, 'SegmentTemplate') ??
		extractFirstTagBlock(audioSet.body, 'SegmentTemplate');
	if (!segmentTemplateBlock) throw new Error('No SegmentTemplate found');

	const stAttrs = parseXmlAttributes(`<SegmentTemplate${segmentTemplateBlock.attrs}>`);
	const baseUrl =
		extractFirstTagText(rep.body, 'BaseURL') ||
		extractFirstTagText(audioSet.body, 'BaseURL') ||
		extractFirstTagText(periodBody, 'BaseURL') ||
		mpdBaseUrl ||
		deriveBaseUrlFromManifestUrl(manifestUrl);

	const timeline = extractFirstTagBlock(segmentTemplateBlock.body, 'SegmentTimeline');
	const startNumber = Number(stAttrs['startNumber'] ?? 1);
	const segments: Array<{ number: number; time: number }> = [];

	if (timeline) {
		let time = 0;
		let number = startNumber;
		for (const entry of extractSelfClosingTags(timeline.body, 'S')) {
			const attrs = parseXmlAttributes(`<S${entry.attrs}>`);
			const duration = Number(attrs['d'] ?? 0);
			const repeat = Number(attrs['r'] ?? 0);
			if (attrs['t'] != null) time = Number(attrs['t']);
			segments.push({ number, time });
			time += duration;
			number += 1;
			for (let i = 0; i < repeat; i++) {
				segments.push({ number, time });
				time += duration;
				number += 1;
			}
		}
	}

	return {
		baseUrl,
		initialization: stAttrs['initialization'] ?? null,
		media: stAttrs['media'] ?? null,
		segments,
		repId: rep.attrs['id'] ?? null,
		mimeType: audioSet.attrs['mimeType'] ?? rep.attrs['mimeType'] ?? null,
		codecs: rep.attrs['codecs'] ?? audioSet.attrs['codecs'] ?? null,
		bandwidth: Number(rep.attrs['bandwidth'] ?? 0),
	};
}

/** Builds absolute segment URLs (initialization first, then media segments). */
export function generateDashSegmentUrls(manifest: DashManifest): string[] {
	const { baseUrl, initialization, media, segments, repId } = manifest;
	const resolveTemplate = (template: string, number: number, time: number): string =>
		template
			.replace(/\$RepresentationID\$/gu, repId ?? '')
			.replace(/\$Number(?:%0(\d+)d)?\$/gu, (_match, width?: string) =>
				width ? String(number).padStart(Number(width), '0') : String(number),
			)
			.replace(/\$Time(?:%0(\d+)d)?\$/gu, (_match, width?: string) =>
				width ? String(time).padStart(Number(width), '0') : String(time),
			)
			.replace(/\$\$/gu, '$');

	const urls: string[] = [];
	if (initialization) {
		// Initialization may reference $RepresentationID$ too.
		const initPath = resolveTemplate(initialization, segments[0]?.number ?? 1, 0);
		urls.push(/^[a-z][a-z0-9+.-]*:/iu.test(initPath) ? initPath : baseUrl + initPath);
	}
	for (const seg of segments) {
		if (!media) break;
		const path = resolveTemplate(media, seg.number, seg.time);
		urls.push(/^[a-z][a-z0-9+.-]*:/iu.test(path) ? path : baseUrl + path);
	}
	return urls;
}

/** Quality token → manifest formats (ported from the reference). */
export function getManifestFormatsForQuality(quality: string): string[] {
	switch (quality.trim().toUpperCase()) {
		case 'LOW':
			return ['HEAACV1', 'AACLC'];
		case 'LOSSLESS':
			return ['FLAC', 'AACLC', 'HEAACV1'];
		case 'HI_RES_LOSSLESS':
		default:
			return ['FLAC_HIRES', 'FLAC', 'AACLC', 'HEAACV1'];
	}
}

/** Container from DASH mimeType/codecs — Phase 2a supports FLAC outputs. */
export function inferDashExtension(mimeType: string | null, codecs: string | null): 'flac' | null {
	const codec = (codecs ?? '').toLowerCase();
	const mt = (mimeType ?? '').toLowerCase();
	if (codec.includes('flac') || mt.includes('flac')) return 'flac';
	return null;
}
