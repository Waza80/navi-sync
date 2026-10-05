import { json, badRequest, notFound, unauthorizedResponse } from '$lib/server/api';
import { getTrackById, setRefetchBlocked } from '$lib/server/db/tracks';
import { logger } from '$lib/server/logger';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const log = logger;

/**
 * POST /api/tracks/[id]/refetch-block — stop or resume refetch attempts.
 *
 * Distinct from Delete, which removes the row AND the file. This only stops the
 * engine trying again, so the row stays visible as a known-unobtainable track and
 * can be revived later with the same endpoint.
 *
 * Useful for tracks that are region-locked or delisted: without it the retry
 * sweep re-attempts them on every cycle indefinitely.
 */
const schema = z.object({ blocked: z.boolean() });

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return badRequest('Expected { "blocked": boolean }.', 'INVALID_BODY');

	const track = await getTrackById(params.id);
	if (!track) return notFound('Track not found');

	await setRefetchBlocked(params.id, parsed.data.blocked);
	log.info('refetch blocked changed', {
		trackId: params.id,
		blocked: parsed.data.blocked,
		by: locals.user.id,
	});

	return json({ id: params.id, refetchBlocked: parsed.data.blocked });
};
