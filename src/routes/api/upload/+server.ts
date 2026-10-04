import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Planned Phase 2: manual upload of audio/lyrics files. */
export const POST: RequestHandler = () => {
	return json(
		{
			error: {
				code: 'NOT_IMPLEMENTED',
				message: 'Manual upload ships in Phase 2.',
			},
		},
		{ status: 501 },
	);
};
