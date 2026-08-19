import { readFile, writeFile } from 'node:fs/promises';
import * as wp from './lib/wp.js';

/**
 * One-off (2026-08-19): pre-creates every missing EN category/tag up front,
 * instead of letting translate.js create them lazily, one by one, as posts
 * happen to need them during automated runs. Lazy creation still works, but
 * doing it here in one deliberate batch means every FR/EN name collision
 * (e.g. "chatbot" -> "Chatbot") gets resolved once, right after deploying
 * the clean-slug fix to tb_create_term, instead of being scattered across
 * dozens of unattended translate runs and needing manual slug cleanup after
 * the fact (see 2026-08-19 category dedup).
 *
 * Driven by /term-audit (ground truth Polylang state), not guesses: for
 * every FR-language term not yet linked to an 'en' translation, creates (or
 * reuses) its EN counterpart via the same get-or-create endpoint
 * translate.js already uses, and caches the result in
 * config/taxonomy-map.json so the next translate run hits the cache
 * directly instead of re-resolving.
 *
 * Run: node create-categories.js [--dry-run]
 */
const DRY_RUN = process.argv.includes('--dry-run');

const TAXONOMY_MAP_PATH = new URL('./config/taxonomy-map.json', import.meta.url);

async function loadCategoryTranslations() {
	const raw = await readFile(new URL('./config/category-translations.json', import.meta.url), 'utf8');
	return JSON.parse(raw);
}

async function loadTaxonomyMap() {
	try {
		const raw = await readFile(TAXONOMY_MAP_PATH, 'utf8');
		return JSON.parse(raw);
	} catch (err) {
		if (err.code === 'ENOENT') return { categories: {}, tags: {} };
		throw err;
	}
}

async function saveTaxonomyMap(map) {
	await writeFile(TAXONOMY_MAP_PATH, JSON.stringify(map, null, 2) + '\n', 'utf8');
}

async function createMissing(taxonomy, mapKey, map, categoryTranslations) {
	const rows = await wp.termAudit(taxonomy);
	const frRows = rows.filter((row) => row.lang === 'fr');

	let created = 0;
	let reused = 0;
	let skipped = 0;
	const missingTranslation = [];

	for (const row of frRows) {
		if (row.translations && row.translations.en) {
			skipped += 1;
			continue;
		}

		const enName = categoryTranslations[row.name];
		if (!enName) {
			missingTranslation.push(row);
			continue;
		}

		console.log(`[${taxonomy}] "${row.name}" (#${row.term_id}) -> "${enName}"`);
		if (DRY_RUN) continue;

		const result = await wp.createOrGetTerm(taxonomy, enName, row.term_id);
		map[mapKey][row.term_id] = result.term_id;
		if (result.created) {
			created += 1;
			console.log(`   created EN term #${result.term_id}`);
		} else {
			reused += 1;
			console.log(`   reused existing EN term #${result.term_id}`);
		}
	}

	return { created, reused, skipped, missingTranslation };
}

async function main() {
	console.log(DRY_RUN ? '=== DRY RUN (no writes) ===' : '=== LIVE RUN ===');

	const categoryTranslations = await loadCategoryTranslations();
	const map = await loadTaxonomyMap();

	const categoriesResult = await createMissing('category', 'categories', map, categoryTranslations);
	const tagsResult = await createMissing('post_tag', 'tags', map, categoryTranslations);

	if (!DRY_RUN) {
		await saveTaxonomyMap(map);
	}

	console.log('');
	console.log('=== Resume ===');
	console.log(
		`Categories creees : ${categoriesResult.created}, reutilisees : ${categoriesResult.reused}, deja liees : ${categoriesResult.skipped}`
	);
	console.log(
		`Etiquettes creees : ${tagsResult.created}, reutilisees : ${tagsResult.reused}, deja liees : ${tagsResult.skipped}`
	);

	const missingAll = [...categoriesResult.missingTranslation, ...tagsResult.missingTranslation];
	if (missingAll.length > 0) {
		console.log('');
		console.log('--- Pas de traduction manuelle dans category-translations.json (ignore) ---');
		for (const row of missingAll) {
			console.log(`  "${row.name}" (#${row.term_id}, ${row.real_count} article(s))`);
		}
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
