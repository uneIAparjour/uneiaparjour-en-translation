const ENDPOINT = 'https://api.cognitive.microsofttranslator.com';

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
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
 * Translates one or more strings FR -> EN via Azure Translator.
 * `isHtml` must be true for content containing markup (tag_handling=html
 * preserves tags and only translates text nodes); false for plain strings
 * like the SEO title/description.
 */
export async function translateBatch(texts, { isHtml, glossary = [] } = {}) {
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

	const res = await fetch(`${ENDPOINT}/translate?${params.toString()}`, {
		method: 'POST',
		headers: {
			'Ocp-Apim-Subscription-Key': key,
			'Ocp-Apim-Subscription-Region': region,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(prepared.map((text) => ({ text }))),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Azure Translator -> ${res.status}: ${body.slice(0, 500)}`);
	}

	const data = await res.json();
	return data.map((entry) => entry.translations[0].text);
}
