import { getPublicSettings } from '$lib/server/settings';
import { ensureMigrated } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	await ensureMigrated();
	return { settings: await getPublicSettings() };
};
