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
 * request (F0's free-tier rate limit is strict enough that one call per text
 * per post — 4+ parallel requests — reliably triggers 429s; batching all of
 * a post's texts into one call cuts that by ~4x). `isHtml` uses
 * tag_handling=html, which is safe even for plain strings with no markup —
 * kept true everywhere callers batch HTML content together with plain text.
 * Retries on 429 with exponential backoff (2s/4s/8s) before giving up.
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
			const delay = 2000 * 2 ** attempt;
			console.log(`Azure rate-limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
			await sleep(delay);
			continue;
		}

		const body = await res.text().catch(() => '');
		throw new Error(`Azure Translator -> ${res.status}: ${body.slice(0, 500)}`);
	}
}
