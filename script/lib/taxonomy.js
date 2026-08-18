import { readFile, writeFile } from 'node:fs/promises';
import * as wp from './wp.js';
import { translateBatch } from './azure.js';

const MAP_PATH = new URL('../config/taxonomy-map.json', import.meta.url);

/**
 * Shape: { categories: { [fr_term_id]: en_term_id }, tags: { [fr_term_id]: en_term_id } }
 */
async function loadMap() {
	try {
		const raw = await readFile(MAP_PATH, 'utf8');
		return JSON.parse(raw);
	} catch (err) {
		if (err.code === 'ENOENT') {
			return { categories: {}, tags: {} };
		}
		throw err;
	}
}

async function saveMap(map) {
	await writeFile(MAP_PATH, JSON.stringify(map, null, 2) + '\n', 'utf8');
}

async function resolveTerm(map, kind, frId, frName, glossary, categoryTranslations) {
	const bucket = map[kind];
	if (bucket[frId]) {
		return bucket[frId];
	}

	// translation-bot (Author) can't create terms via the standard REST
	// endpoints, so this goes through the bridge plugin's gated
	// get-or-create endpoint instead (found during the first live test).
	// Passing frId lets the bridge plugin link the EN term to its FR source
	// as a Polylang translation pair (fixed 2026-08-18 — was previously
	// leaving new EN terms orphaned, a known v1 gap).
	const taxonomy = kind === 'categories' ? 'category' : 'post_tag';

	// Azure translates short, context-free single words unreliably (found
	// live 2026-08-18: "vidéo" sent alone came back as "vidéo", unchanged —
	// unlike full sentences, where surrounding context helps). This site's
	// category/tag names are a small, finite, known set, so a hand-verified
	// lookup table beats machine translation here; only fall back to Azure
	// for a name that isn't in it yet (a brand-new category never seen before).
	const manualTranslation = categoryTranslations[frName];
	const translatedName = manualTranslation || (await translateBatch([frName], { isHtml: true, glossary }))[0];

	const result = await wp.createOrGetTerm(taxonomy, translatedName, frId);

	bucket[frId] = result.term_id;
	return result.term_id;
}

/**
 * Maps a set of FR category/tag term objects ({id, name}) to EN term IDs,
 * creating the EN term (once, cached) the first time each is encountered.
 */
export async function mapTerms({ categories = [], tags = [] }, glossary, categoryTranslations = {}) {
	const map = await loadMap();

	const enCategoryIds = [];
	for (const term of categories) {
		enCategoryIds.push(await resolveTerm(map, 'categories', term.id, term.name, glossary, categoryTranslations));
	}

	const enTagIds = [];
	for (const term of tags) {
		enTagIds.push(await resolveTerm(map, 'tags', term.id, term.name, glossary, categoryTranslations));
	}

	await saveMap(map);

	return { categories: enCategoryIds, tags: enTagIds };
}
