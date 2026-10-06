import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { getSettings } from '$lib/server/settings';
import { enqueueJob } from '$lib/server/queue/jobs';
import { ping } from '$lib/server/navidrome/subsonic';
import type { RequestHandler } from './$types';

/** POST /api/navidrome/scan — trigger a Navidrome library scan (queued job). */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const user = locals.user;

	// Optional {"pingOnly": true} runs a synchronous connection test instead.
	const body = (await request.json().catch(() => ({}))) as { pingOnly?: boolean; full?: boolean };
	const s = await getSettings();
	if (!s.navidromeUrl || !s.navidromeUsername || !s.navidromePassword) {
		return badRequest(
			'Navidrome is not fully configured (URL, username, password).',
			'NOT_CONFIGURED',
		);
	}

	if (body.pingOnly) {
		const result = await ping(s.navidromeUrl, s.navidromeUsername, s.navidromePassword);
		return json(result, { status: result.ok ? 200 : 502 });
	}

	const job = await enqueueJob({
		type: 'navidrome_scan',
		payload: { full: body.full === true },
		createdBy: user.id,
	});
	return json(
		{ job: { id: job.id, type: job.type, status: job.status }, full: body.full === true },
		{ status: 202 },
	);
};
