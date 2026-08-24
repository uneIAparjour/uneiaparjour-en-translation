import * as wp from './lib/wp.js';
import { loadState, saveState, hashSource } from './lib/state.js';
import { readFile } from 'node:fs/promises';

/**
 * One-off repair (2026-08-24), follow-up to debug-orphan-drafts.js: 27 EN
 * draft posts (ids 18799-18826) were created by an old translate.js run
 * that got interrupted before reaching the final state-commit step — real
 * WordPress posts exist, but state/translations.json has no record of
 * them, and 26 of the 27 carry the pre-fix "categories set before Polylang
 * language" bug (FR-language category ids instead of EN ones).
 *
 * This script:
 *   1. Finds each orphan EN post's FR source by exact date_gmt match
 *      (translate.js copies the FR post's date verbatim on creation, so
 *      this is a precise, non-guessing match).
 *   2. For any FR-language category id on the EN post, resolves the
 *      correct EN category via config/category-translations.json + a live
 *      term-audit lookup, and plans a categories fix.
 *   3. Backfills a state/translations.json entry for each (fr_id, en_id,
 *      en_slug, source_hash computed from the FR post's CURRENT raw
 *      content/title/yoast fields — matches how translate.js hashes on a
 *      normal run) so a future run recognizes these as already translated
 *      instead of creating duplicates.
 *
 * --dry-run (default): print the plan, write nothing.
 * --apply: actually PATCH categories on WordPress and save state.json.
 *
 * Run: node repair-orphan-drafts.js [--apply]
 */

const APPLY = process.argv.includes('--apply');
const stripHtml = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// Term names come back from the WP REST/term-audit endpoints with HTML
// entities intact (e.g. "Quiz &amp; Flashcards"), while
// config/category-translations.json is written in plain text — decode
// before comparing so lookups aren't defeated by "&" vs "&amp;" etc.
const decodeEntities = (s) =>
	(s || '')
		.replace(/&amp;/g, '&')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&#8217;/g, '’')
		.replace(/&#8216;/g, '‘');
// Lookup key: decode entities, fold curly quotes to straight, lowercase,
// collapse whitespace — so "Children&#8217;s Stories" (live) matches
// "Children's Stories" (category-translations.json).
const normKey = (s) =>
	decodeEntities(s)
		.replace(/[’‘]/g, "'")
		.toLowerCase()
		.trim()
		.replace(/\s+/g, ' ');

async function main() {
	const state = await loadState();
	const knownEnIds = new Set(Object.values(state).map((s) => s.en_id).filter(Boolean));

	const categoryTranslations = JSON.parse(
		await readFile(new URL('./config/category-translations.json', import.meta.url), 'utf8')
	);

	console.log('Fetching FR posts, EN drafts, and term audit...');
	const [frPosts, enDrafts, categoryRows, tagRows] = await Promise.all([
		wp.listAllPosts('publish'),
		wp.listAllPosts('draft'),
		wp.termAudit('category'),
		wp.termAudit('post_tag'),
	]);

	const termById = new Map();
	const enTermByName = new Map(); // taxonomy:name(lowercase) -> {id, name}
	for (const row of [...categoryRows.map((r) => ({ ...r, tax: 'category' })), ...tagRows.map((r) => ({ ...r, tax: 'post_tag' }))]) {
		termById.set(row.term_id, { name: decodeEntities(row.name), lang: row.lang, tax: row.tax });
		if (row.lang === 'en') {
			enTermByName.set(`${row.tax}:${normKey(row.name)}`, row.term_id);
		}
	}

	const frByDateGmt = new Map();
	for (const p of frPosts) {
		if (p.date_gmt) frByDateGmt.set(p.date_gmt, p);
	}

	const orphans = enDrafts.filter((p) => !knownEnIds.has(p.id));
	console.log(`${orphans.length} orphan draft(s) found.\n`);

	let matched = 0;
	let unmatched = 0;
	let categoryFixes = 0;
	let unresolvedCategories = 0;

	for (const enPost of orphans) {
		const enTitle = enPost.title?.rendered || enPost.title || '(sans titre)';
		const frPost = frByDateGmt.get(enPost.date_gmt);

		if (!frPost) {
			console.log(`EN #${enPost.id} "${enTitle}" -> NO FR MATCH (date_gmt ${enPost.date_gmt}), skipped.\n`);
			unmatched += 1;
			continue;
		}
		matched += 1;

		const fixedCategoryIds = [];
		const notes = [];
		for (const catId of enPost.categories || []) {
			const term = termById.get(catId);
			if (!term || term.lang === 'en') {
				fixedCategoryIds.push(catId); // already fine (or unknown, leave as-is)
				continue;
			}
			const enName = categoryTranslations[term.name];
			const enId = enName ? enTermByName.get(`category:${normKey(enName)}`) : null;
			if (enId) {
				fixedCategoryIds.push(enId);
				notes.push(`  #${catId} "${term.name}" (fr) -> #${enId} "${enName}" (en)`);
			} else {
				notes.push(`  #${catId} "${term.name}" (fr) -> NO EN MAPPING FOUND, left as-is (needs manual fix)`);
				fixedCategoryIds.push(catId);
				unresolvedCategories += 1;
			}
		}
		if (notes.length > 0) categoryFixes += 1;

		const title = stripHtml(frPost.title.rendered);
		const content = frPost.content.rendered;
		const yoastTitle = frPost.yoast_title || '';
		const yoastMetadesc = frPost.yoast_metadesc || '';
		const sourceHash = hashSource({ title, content: frPost.raw_content || content, yoastTitle, yoastMetadesc });

		console.log(`EN #${enPost.id} "${enTitle}"  <->  FR #${frPost.id} "${title}" (/${frPost.slug}/)`);
		for (const n of notes) console.log(n);
		console.log(`  state entry (fr #${frPost.id}): en_id=${enPost.id}, en_slug=${enPost.slug}, source_hash=${sourceHash.slice(0, 12)}...`);
		console.log('');

		if (APPLY) {
			if (notes.length > 0) {
				await wp.updatePost(enPost.id, { categories: fixedCategoryIds });
			}
			state[frPost.id] = {
				fr_slug: frPost.slug,
				en_id: enPost.id,
				en_slug: enPost.slug,
				source_hash: sourceHash,
				status: 'translated',
				last_error: null,
				updated_at: new Date().toISOString(),
			};
		}
	}

	console.log(`\n=== Summary ===`);
	console.log(`Matched to a FR source: ${matched}`);
	console.log(`No FR match found     : ${unmatched}`);
	console.log(`Posts needing a category fix: ${categoryFixes}`);
	console.log(`Categories with no EN mapping (left untouched): ${unresolvedCategories}`);
	console.log(APPLY ? '\nAPPLY mode: WordPress categories patched, state/translations.json updated in-memory (commit it via the workflow\'s existing state-commit step or manually).' : '\nDRY RUN: nothing written. Re-run with --apply to write.');

	if (APPLY) {
		await saveState(state);
		console.log('state/translations.json written locally.');
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
