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
 * All posts, paginated. Deliberately not filtering by lang param — Polylang's
 * REST language filtering isn't confirmed reliable on the free tier, so
 * instead the caller excludes known EN post IDs using the state file.
 * Defaults to published only (the original behavior, still what every
 * existing caller wants); pass 'draft', 'any', etc. to look at other
 * statuses — e.g. publish.js needs 'draft' to find EN posts ready to go live.
 */
export async function listAllPosts(status = 'publish') {
	const posts = [];
	let page = 1;
	// WP REST caps at 100 per page.
	const perPage = 100;

	while (true) {
		const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&status=${status}&_fields=id,slug,title,content,excerpt,date,date_gmt,status,raw_content,yoast_title,yoast_metadesc,featured_media,categories,tags,meta`, {
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
	return wpFetch(`/wp/v2/posts/${id}?_fields=id,slug,title,content,excerpt,date,date_gmt,status,raw_content,yoast_title,yoast_metadesc,featured_media,categories,tags,meta`);
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

/**
 * Paginated, same reasoning as listAllPosts(): a flat per_page=100 fetch
 * would silently truncate if the site ever has more than 100 categories or
 * tags, and a caller falling back to a numeric ID as the "name" for any
 * term missed that way (found while reviewing fix-categories.js) could end
 * up creating a category literally named after its own ID.
 */
async function listAllTerms(taxonomy, search) {
	const terms = [];
	let page = 1;
	const perPage = 100;

	while (true) {
		const qs = new URLSearchParams({ per_page: String(perPage), page: String(page) });
		if (search) qs.set('search', search);
		const res = await fetch(`${WP_URL}/wp-json/wp/v2/${taxonomy}?${qs.toString()}`, {
			headers: { Authorization: AUTH_HEADER },
		});

		if (!res.ok) {
			if (res.status === 400 && page > 1) {
				break; // past the last page, same as listAllPosts()
			}
			const body = await res.text().catch(() => '');
			throw new Error(`WP REST GET /wp/v2/${taxonomy} (page ${page}) -> ${res.status}: ${body.slice(0, 500)}`);
		}

		const batch = await res.json();
		if (!Array.isArray(batch) || batch.length === 0) break;
		terms.push(...batch);
		if (batch.length < perPage) break;
		page += 1;
	}

	return terms;
}

export async function listCategories(search) {
	return listAllTerms('categories', search);
}

export async function listTags(search) {
	return listAllTerms('tags', search);
}

/**
 * translation-bot (Author) can't create terms via the standard /wp/v2
 * endpoints (rest_cannot_create) — this goes through the bridge plugin's
 * own gated endpoint instead. Get-or-create in one call. `frTermId`, when
 * given, links the new/found EN term to its FR source as a Polylang
 * translation pair — without it, EN category/tag terms end up orphaned
 * (a v1 gap closed 2026-08-18).
 */
export async function createOrGetTerm(taxonomy, name, frTermId) {
	return wpFetch('/translation-bridge/v1/create-term', {
		method: 'POST',
		body: JSON.stringify({ taxonomy, name, fr_term_id: frTermId }),
	});
}

export async function setTermLanguage(termId, lang) {
	return wpFetch('/translation-bridge/v1/set-term-language', {
		method: 'POST',
		body: JSON.stringify({ term_id: termId, lang }),
	});
}

/**
 * Ground-truth per-term Polylang state (language + linked translations) —
 * used by the one-off category/tag language cleanup, since the standard
 * /wp/v2 endpoints don't expose Polylang's per-term language at all.
 */
export async function termAudit(taxonomy) {
	return wpFetch(`/translation-bridge/v1/term-audit?taxonomy=${encodeURIComponent(taxonomy)}`);
}

export async function deleteTerm(termId, taxonomy) {
	return wpFetch('/translation-bridge/v1/delete-term', {
		method: 'POST',
		body: JSON.stringify({ term_id: termId, taxonomy }),
	});
}
