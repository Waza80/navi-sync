import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Planned Phase 2: streaming ZIP export (Artist/Album/NN - Title + sidecars). */
export const GET: RequestHandler = () => {
	return json(
		{
			error: {
				code: 'NOT_IMPLEMENTED',
				message:
					'ZIP export ships in Phase 2 (streaming compression for 100+ GB libraries).',
			},
		},
		{ status: 501 },
	);
};
