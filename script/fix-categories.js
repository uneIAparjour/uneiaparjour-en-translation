import { readFile, writeFile } from 'node:fs/promises';
import * as wp from './lib/wp.js';
import { mapTerms } from './lib/taxonomy.js';
import { loadState } from './lib/state.js';

/**
 * One-off migration (2026-08-18): the site's original Polylang misconfiguration
 * (English set as default before French was added — same root cause as
 * fix-language.js) mislabeled every pre-existing category/tag as English too,
 * never corrected because fix-language.js only touched post language. On top
 * of that, an earlier version of the bridge plugin's /create-term endpoint
 * created new terms without setting a language at all, leaving a scatter of
 * empty, wrongly-labeled, unlinked junk terms.
 *
 * This script, driven entirely by live data from the new /term-audit
 * endpoint (not guessed from names/slugs):
 *   1. Deletes any term with 0 real posts (any status, not just published —
 *      see real_count below) — safe leftover junk, refused server-side if
 *      WordPress reports it's not actually empty (e.g. the default category).
 *   2. Leaves anything with 1-2 posts alone and just reports it — a French/
 *      English pair that both hold a couple of posts needs a human decision
 *      about which posts belong where, not an automated guess.
 *   3. Purges config/taxonomy-map.json cache entries that pointed at a term
 *      relabeled to "fr" (stale — created before the language-aware fix to
 *      /create-term, when it blindly reused same-named terms).
 *   4. Re-resolves categories/tags for every already-translated EN post and
 *      patches them if they changed.
 *
 * REMOVED 2026-08-18 (was step 1): auto-relabeling any "en"-tagged term with
 * >=3 posts back to "fr". That was safe exactly once, for the original
 * one-time cleanup of ~34 pre-existing categories mislabeled English at
 * Polylang setup time (all now fixed, confirmed via a live audit). Run again
 * afterwards, it can't tell "old French content mislabeled English" apart
 * from "new, legitimately English category with real draft posts" — both
 * just look like "lang=en, several posts" — and it relabeled 4 genuinely
 * English, actively-used categories (Chatbot, Documents, Images, Video) back
 * to French, corrupting them on live drafts. User fixed those 4 by hand in
 * wp-admin afterwards. Do not reintroduce this behavior; any remaining
 * lang=en term with real posts is now just reported as an anomaly instead.
 *
 * Run: node fix-categories.js [--dry-run]
 * --dry-run previews steps 1-3 (no writes) and skips step 4 entirely.
 */
const DRY_RUN = process.argv.includes('--dry-run');

async function loadGlossary() {
	const raw = await readFile(new URL('./config/glossary.json', import.meta.url), 'utf8');
	return JSON.parse(raw);
}

async function loadCategoryTranslations() {
	const raw = await readFile(new URL('./config/category-translations.json', import.meta.url), 'utf8');
	return JSON.parse(raw);
}

const TAXONOMY_MAP_PATH = new URL('./config/taxonomy-map.json', import.meta.url);

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

async function auditAndFix(taxonomy) {
	const rows = await wp.termAudit(taxonomy);
	const relabeled = [];
	const deleted = [];
	const flagged = [];
	const failed = [];
	const anomalies = [];

	for (const row of rows) {
		// real_count (any post status) drives every decision here, not
		// count (published-only) — this project's EN posts stay in draft
		// for review, so count is permanently 0 for every EN term
		// regardless of how many drafts actually use it. Trusting count
		// would have deleted actively-used categories (found live
		// 2026-08-18, caught only because the delete calls happened to
		// fail for an unrelated permissions reason first).
		const realCount = row.real_count;
		if (realCount === 0) {
			console.log(`[${taxonomy}] Delete empty "${row.name}" (#${row.term_id}, slug ${row.slug})`);
			if (!DRY_RUN) {
				try {
					await wp.deleteTerm(row.term_id, taxonomy);
					deleted.push(row);
				} catch (err) {
					if (/refused to delete/i.test(err.message)) {
						console.log('   skipped (WordPress refused — likely the default category)');
					} else {
						failed.push({ ...row, error: err.message });
					}
				}
			} else {
				deleted.push(row);
			}
		} else if (realCount <= 2) {
			flagged.push(row);
		} else if (row.lang !== 'fr') {
			// A term with 3+ real posts and a language that isn't "fr" —
			// report only, never auto-fix. This used to auto-relabel "en"
			// straight to "fr" here, safe only for the one-time original
			// cleanup of pre-existing mislabeled categories; run again after
			// the pipeline itself had created legitimate, actively-used
			// English categories, it corrupted 4 of them (see file header,
			// 2026-08-18). Any future case needs a human to tell "old
			// mislabeled French content" apart from "new real English
			// category" — this script can't.
			anomalies.push(row);
		}
		// else: row.lang === 'fr' with real_count >= 3 — already correct, no action.
	}

	return { relabeled, deleted, flagged, failed, anomalies };
}

async function purgeStaleCache(relabeledIds) {
	const map = await loadTaxonomyMap();
	let purged = 0;
	for (const kind of ['categories', 'tags']) {
		for (const [frId, enId] of Object.entries(map[kind])) {
			if (relabeledIds.has(enId)) {
				delete map[kind][frId];
				purged += 1;
			}
		}
	}
	if (!DRY_RUN && purged > 0) {
		await saveTaxonomyMap(map);
	}
	return purged;
}

async function reresolveTranslatedPosts(glossary, categoryTranslations) {
	const state = await loadState();
	const allPosts = await wp.listAllPosts();
	const postsById = new Map(allPosts.map((p) => [p.id, p]));
	const [allCategories, allTags] = await Promise.all([wp.listCategories(), wp.listTags()]);
	const categoryNames = new Map(allCategories.map((t) => [t.id, t.name]));
	const tagNames = new Map(allTags.map((t) => [t.id, t.name]));

	let checked = 0;
	let updated = 0;
	const failed = [];

	for (const [frIdStr, entry] of Object.entries(state)) {
		if (entry.status !== 'translated' || !entry.en_id) continue;
		const frId = Number(frIdStr);
		const frPost = postsById.get(frId);
		if (!frPost) continue; // FR source not found under this ID anymore — out of scope here, report.js already flags these separately
		checked += 1;

		// One post's failure (e.g. a term-creation edge case) shouldn't stop
		// the rest of the batch from being checked — same per-item isolation
		// as translate.js's main loop.
		try {
			const { categories: enCategories, tags: enTags } = await mapTerms(
				{
					categories: frPost.categories.map((id) => ({ id, name: categoryNames.get(id) || String(id) })),
					tags: frPost.tags.map((id) => ({ id, name: tagNames.get(id) || String(id) })),
				},
				glossary,
				categoryTranslations
			);

			const enPost = await wp.getPost(entry.en_id);
			const sameCategories = JSON.stringify([...enPost.categories].sort()) === JSON.stringify([...enCategories].sort());
			const sameTags = JSON.stringify([...enPost.tags].sort()) === JSON.stringify([...enTags].sort());

			if (!sameCategories || !sameTags) {
				console.log(`FR #${frId} -> EN #${entry.en_id}: categories/tags changed, updating.`);
				await wp.updatePost(entry.en_id, { categories: enCategories, tags: enTags });
				updated += 1;
			}
		} catch (err) {
			console.error(`FR #${frId} -> EN #${entry.en_id}: failed, skipping. ${err.message}`);
			failed.push({ frId, enId: entry.en_id, error: err.message });
		}
	}

	return { checked, updated, failed };
}

async function main() {
	console.log(DRY_RUN ? '=== DRY RUN (no writes) ===' : '=== LIVE RUN ===');

	const categoriesResult = await auditAndFix('category');
	const tagsResult = await auditAndFix('post_tag');

	console.log('');
	console.log('=== Resume relabellisation/nettoyage ===');
	console.log(`Categories relabellisees en fr : ${categoriesResult.relabeled.length}`);
	console.log(`Etiquettes relabellisees en fr : ${tagsResult.relabeled.length}`);
	console.log(`Categories vides supprimees    : ${categoriesResult.deleted.length}`);
	console.log(`Etiquettes vides supprimees    : ${tagsResult.deleted.length}`);

	const flaggedAll = [...categoriesResult.flagged, ...tagsResult.flagged];
	if (flaggedAll.length > 0) {
		console.log('');
		console.log('--- A verifier a la main (1-2 articles, jamais touche automatiquement) ---');
		for (const row of flaggedAll) {
			console.log(`  "${row.name}" (#${row.term_id}, slug ${row.slug}, ${row.real_count} article(s), lang=${row.lang})`);
		}
	}

	const failedAll = [...categoriesResult.failed, ...tagsResult.failed];
	if (failedAll.length > 0) {
		console.log('');
		console.log('--- Echecs ---');
		for (const row of failedAll) {
			console.log(`  "${row.name}" (#${row.term_id}) : ${row.error}`);
		}
	}

	const anomaliesAll = [...categoriesResult.anomalies, ...tagsResult.anomalies];
	if (anomaliesAll.length > 0) {
		console.log('');
		console.log('--- Anomalies (langue Polylang inattendue, non touche) ---');
		for (const row of anomaliesAll) {
			console.log(`  "${row.name}" (#${row.term_id}, slug ${row.slug}, ${row.real_count} article(s), lang=${row.lang ?? '(vide)'})`);
		}
	}

	const relabeledIds = new Set([...categoriesResult.relabeled, ...tagsResult.relabeled].map((r) => r.term_id));
	const purged = await purgeStaleCache(relabeledIds);
	console.log('');
	console.log(`Entrees de cache obsoletes purgees : ${purged}`);

	if (DRY_RUN) {
		console.log('');
		console.log('=== DRY RUN: etape de re-resolution des articles deja traduits ignoree ===');
		return;
	}

	console.log('');
	console.log('=== Re-resolution des categories/tags des articles deja traduits ===');
	const glossary = await loadGlossary();
	const categoryTranslations = await loadCategoryTranslations();
	const { checked, updated, failed: reresolveFailed } = await reresolveTranslatedPosts(glossary, categoryTranslations);
	console.log(`Articles verifies : ${checked}, mis a jour : ${updated}, echoues : ${reresolveFailed.length}`);
	if (reresolveFailed.length > 0) {
		console.log('');
		console.log('--- Echecs de re-resolution (a relancer plus tard, rien de perdu) ---');
		for (const f of reresolveFailed) {
			console.log(`  FR #${f.frId} -> EN #${f.enId} : ${f.error}`);
		}
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
