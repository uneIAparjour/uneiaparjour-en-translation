const WP_URL = requireEnv('WP_URL').replace(/\/$/, '');
const AUTH_HEADER =
	'Basic ' + Buffer.from(`${requireEnv('WP_USERNAME')}:${requireEnv('WP_APP_PASSWORD')}`).toString('base64');

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

async function wpFetch(path, options = {}) {
	const res = await fetch(`${WP_URL}/wp-json${path}`, {
		...options,
		headers: {
			Authorization: AUTH_HEADER,
			'Content-Type': 'application/json',
			...options.headers,
		},
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`WP REST ${options.method || 'GET'} ${path} -> ${res.status}: ${body.slice(0, 500)}`);
	}

	if (res.status === 204) {
		return null;
	}

	return res.json();
}

/**
 * All published posts, paginated. Deliberately not filtering by lang param —
 * Polylang's REST language filtering isn't confirmed reliable on the free
 * tier, so instead the caller excludes known EN post IDs using the state file.
 */
export async function listAllPosts() {
	const posts = [];
	let page = 1;
	// WP REST caps at 100 per page.
	const perPage = 100;

	while (true) {
		const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&_fields=id,slug,title,content,excerpt,date,date_gmt,yoast_title,yoast_metadesc,featured_media,categories,tags,meta`, {
			headers: { Authorization: AUTH_HEADER },
		});

		if (!res.ok) {
			if (res.status === 400 && page > 1) {
				// WP returns 400 "rest_post_invalid_page_number" once you go past the last page.
				break;
			}
			const body = await res.text().catch(() => '');
			throw new Error(`WP REST GET /wp/v2/posts (page ${page}) -> ${res.status}: ${body.slice(0, 500)}`);
		}

		const batch = await res.json();
		if (!Array.isArray(batch) || batch.length === 0) {
			break;
		}
		posts.push(...batch);
		if (batch.length < perPage) {
			break;
		}
		page += 1;
	}

	return posts;
}

export async function getPost(id) {
	return wpFetch(`/wp/v2/posts/${id}?_fields=id,slug,title,content,excerpt,date,date_gmt,yoast_title,yoast_metadesc,featured_media,categories,tags,meta`);
}

export async function createPost(data) {
	return wpFetch('/wp/v2/posts', {
		method: 'POST',
		body: JSON.stringify(data),
	});
}

export async function updatePost(id, data) {
	return wpFetch(`/wp/v2/posts/${id}`, {
		method: 'POST', // WP REST accepts POST for partial updates; PATCH also works but POST is the documented default.
		body: JSON.stringify(data),
	});
}

export async function linkTranslations(frId, enId) {
	return wpFetch('/translation-bridge/v1/link', {
		method: 'POST',
		body: JSON.stringify({ fr_id: frId, en_id: enId }),
	});
}

export async function setLanguage(postId, lang) {
	return wpFetch('/translation-bridge/v1/set-language', {
		method: 'POST',
		body: JSON.stringify({ post_id: postId, lang }),
	});
}

export async function listCategories(search) {
	const qs = search ? `?search=${encodeURIComponent(search)}&per_page=100` : '?per_page=100';
	return wpFetch(`/wp/v2/categories${qs}`);
}

export async function listTags(search) {
	const qs = search ? `?search=${encodeURIComponent(search)}&per_page=100` : '?per_page=100';
	return wpFetch(`/wp/v2/tags${qs}`);
}

/**
 * translation-bot (Author) can't create terms via the standard /wp/v2
 * endpoints (rest_cannot_create) — this goes through the bridge plugin's
 * own gated endpoint instead. Get-or-create in one call.
 */
export async function createOrGetTerm(taxonomy, name) {
	return wpFetch('/translation-bridge/v1/create-term', {
		method: 'POST',
		body: JSON.stringify({ taxonomy, name }),
	});
}
