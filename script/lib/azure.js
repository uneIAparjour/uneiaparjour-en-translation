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
const MIN_INTERVAL_MS = 6000; // bumped from 2000: still 429ing with 2s spacing (3rd live test) — looks like a rolling-window quota, not just a per-call gap
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
 */
export function applyDictionary(text, glossary) {
	let result = text;
	for (const { term, translation } of glossary) {
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const pattern = new RegExp(`(?<!<mstrans:dictionary translation="[^"]*">)\\b${escaped}\\b`, 'g');
		result = result.replace(pattern, `<mstrans:dictionary translation="${translation}">${term}</mstrans:dictionary>`);
	}
	return result;
}

/**
 * Translates one or more strings FR -> EN via Azure Translator, in a single
 * request. `isHtml` uses tag_handling=html, which is safe even for plain
 * strings with no markup — kept true everywhere callers batch HTML content
 * together with plain text. Every call (from here or from taxonomy.js's
 * separate category/tag name lookups) goes through throttle() first, and
 * still retries on 429 with exponential backoff (2s/4s/8s) as a second line
 * of defense — F0's rate limit turned out too strict for per-post batching
 * alone to reliably avoid.
 */
export async function translateBatch(texts, { isHtml, glossary = [], retries = 3 } = {}) {
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
			const delay = 5000 * 2 ** attempt; // 5s/10s/20s
			console.log(`Azure rate-limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
			await sleep(delay);
			continue;
		}

		const body = await res.text().catch(() => '');
		throw new Error(`Azure Translator -> ${res.status}: ${body.slice(0, 500)}`);
	}
}
