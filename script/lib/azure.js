const ENDPOINT = 'https://api.cognitive.microsofttranslator.com';

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Global pacing across every Azure call in the process, not just per-post —
 * category/tag name translation (lib/taxonomy.js) makes its own separate
 * calls, so per-post batching alone wasn't enough to stay under F0's rate
 * limit (found during the second live test: still 429ing with batched
 * per-post calls). A shared minimum interval covers every call site.
 */
let lastCallAt = 0;
const MIN_INTERVAL_MS = 12000; // bumped from 6000 (itself bumped from 2000): a 2026-08-18 batch of 50 posts still 429'd on ~7 of them at 6s spacing, each burning through all 4 retries (8/16/32/64s backoff, ~2min wasted) before failing outright — the rolling-window quota suspected earlier is apparently tighter than 1 call/6s
async function throttle() {
	const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
	if (wait > 0) {
		await sleep(wait);
	}
	lastCallAt = Date.now();
}

/**
 * Wraps glossary terms in Azure's dynamic-dictionary markup so protected
 * brand/model names (Claude, Gemma, GLM...) survive translation untouched.
 * Case-sensitive, word-boundary matches only, skips terms already wrapped.
 * See config/glossary.json for the list.
 *
 * Splits the text into alternating "inside an HTML tag" (`<...>`, e.g. an
 * `href` attribute) and "plain text between tags" segments first, and skips
 * substitution on: (a) the tag segments themselves, and (b) any text
 * segment that is itself a bare URL. This site frequently links a source
 * with the URL as the link's own visible text (`<a href="...">https://www.
 * youtube.com/...</a>`) — found live (2026-08-28): substituting "youtube"
 * or "html" inside that visible-URL text corrupted it once Azure's
 * HTML-aware translation processed the resulting `<mstrans:dictionary>`
 * markup sitting inside what looks like a URL (e.g. "youtube.com" came
 * back as "YouTube. com"). Doesn't catch a URL embedded mid-sentence
 * alongside other prose in the same segment — not a pattern seen live yet.
 */
export function applyDictionary(text, glossary) {
	const segments = text.split(/(<[^>]*>)/);
	return segments
		.map((segment) => {
			if (segment.startsWith('<') || /^\s*https?:\/\//.test(segment)) {
				return segment;
			}
			let result = segment;
			for (const { term, translation } of glossary) {
				const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const pattern = new RegExp(`(?<!<mstrans:dictionary translation="[^"]*">)\\b${escaped}\\b`, 'g');
				result = result.replace(pattern, `<mstrans:dictionary translation="${translation}">${term}</mstrans:dictionary>`);
			}
			return result;
		})
		.join('');
}

/**
 * Translates one or more strings FR -> EN via Azure Translator, in a single
 * request. `isHtml` uses tag_handling=html, which is safe even for plain
 * strings with no markup — kept true everywhere callers batch HTML content
 * together with plain text. Every call (from here or from taxonomy.js's
 * separate category/tag name lookups) goes through throttle() first, and
 * still retries on 429, honoring Azure's Retry-After header when present
 * rather than guessing — F0's rate limit turned out too strict for
 * per-post batching and a fixed delay guess to reliably avoid.
 */
export async function translateBatch(texts, { isHtml, glossary = [], retries = 4 } = {}) {
	if (texts.length === 0) {
		return [];
	}

	const key = requireEnv('AZURE_TRANSLATOR_KEY');
	const region = requireEnv('AZURE_TRANSLATOR_REGION');

	const prepared = texts.map((t) => applyDictionary(t, glossary));

	const params = new URLSearchParams({
		'api-version': '3.0',
		from: 'fr',
		to: 'en',
	});
	if (isHtml) {
		params.set('textType', 'html');
	}

	for (let attempt = 0; attempt <= retries; attempt++) {
		await throttle();
		const res = await fetch(`${ENDPOINT}/translate?${params.toString()}`, {
			method: 'POST',
			headers: {
				'Ocp-Apim-Subscription-Key': key,
				'Ocp-Apim-Subscription-Region': region,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(prepared.map((text) => ({ text }))),
		});

		if (res.ok) {
			const data = await res.json();
			return data.map((entry) => entry.translations[0].text);
		}

		if (res.status === 429 && attempt < retries) {
			// Prefer Azure's own Retry-After header over our guessed backoff —
			// three rounds of manually widening the delay (2s/6s/still 429ing)
			// suggest a rolling-window quota we can't correctly guess from the
			// outside. Log every header on a 429 too, for real diagnostic data
			// if this still isn't enough.
			const retryAfterHeader = res.headers.get('retry-after');
			const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
			const delay = retryAfterMs && !Number.isNaN(retryAfterMs) ? retryAfterMs : 8000 * 2 ** attempt; // fallback 8s/16s/32s

			const headerDump = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join(' | ');
			console.log(
				`Azure rate-limited (429), retry-after header: ${retryAfterHeader ?? 'none'}, waiting ${delay}ms (attempt ${attempt + 1}/${retries}). Headers: ${headerDump}`
			);
			await sleep(delay);
			continue;
		}

		const body = await res.text().catch(() => '');
		throw new Error(`Azure Translator -> ${res.status}: ${body.slice(0, 500)}`);
	}
}
