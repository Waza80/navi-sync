import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** `/` routes to the app when signed in, to the login screen otherwise. */
export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) redirect(302, '/dashboard');
	redirect(302, '/login');
};
