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

async function resolveTerm(map, kind, frId, frName, glossary) {
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

	const [translatedName] = await translateBatch([frName], { isHtml: true, glossary });
	const result = await wp.createOrGetTerm(taxonomy, translatedName, frId);

	bucket[frId] = result.term_id;
	return result.term_id;
}

/**
 * Maps a set of FR category/tag term objects ({id, name}) to EN term IDs,
 * creating the EN term (once, cached) the first time each is encountered.
 */
export async function mapTerms({ categories = [], tags = [] }, glossary) {
	const map = await loadMap();

	const enCategoryIds = [];
	for (const term of categories) {
		enCategoryIds.push(await resolveTerm(map, 'categories', term.id, term.name, glossary));
	}

	const enTagIds = [];
	for (const term of tags) {
		enTagIds.push(await resolveTerm(map, 'tags', term.id, term.name, glossary));
	}

	await saveMap(map);

	return { categories: enCategoryIds, tags: enTagIds };
}
