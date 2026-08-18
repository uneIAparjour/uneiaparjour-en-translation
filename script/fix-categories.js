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
 *   1. Relabels any term with >=3 posts still tagged "en" back to "fr" —
 *      unambiguous, these predate the EN pipeline and hold real French content.
 *   2. Deletes any term with 0 posts — safe leftover junk, refused server-side
 *      if WordPress reports it's not actually empty (e.g. the default category).
 *   3. Leaves anything with 1-2 posts alone and just reports it — a French/
 *      English pair that both hold a couple of posts needs a human decision
 *      about which posts belong where, not an automated guess.
 *   4. Purges config/taxonomy-map.json cache entries that pointed at a term
 *      just relabeled to "fr" (stale — created before the language-aware fix
 *      to /create-term, when it blindly reused same-named terms).
 *   5. Re-resolves categories/tags for every already-translated EN post and
 *      patches them if they changed — cleans up the mixing-in-with-French
 *      that step 1 alone would otherwise leave behind on existing EN posts.
 *
 * Run: node fix-categories.js [--dry-run]
 * --dry-run previews steps 1-4 (no writes) and skips step 5 entirely, since
 * re-resolving against terms that weren't actually relabeled wouldn't mean
 * anything.
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
		if (row.count === 0) {
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
		} else if (row.count <= 2) {
			flagged.push(row);
		} else if (row.lang === 'en') {
			console.log(`[${taxonomy}] Relabel "${row.name}" (#${row.term_id}, ${row.count} posts) en -> fr`);
			if (!DRY_RUN) {
				try {
					await wp.setTermLanguage(row.term_id, 'fr');
				} catch (err) {
					failed.push({ ...row, error: err.message });
					continue;
				}
			}
			relabeled.push(row);
		} else if (row.lang !== 'fr') {
			// A term with real posts but a language that's neither "en" nor
			// "fr" (missing/unexpected) — don't guess which way to fix it,
			// just surface it. Not expected to happen, but silently doing
			// nothing here would be worse than a slightly noisy report.
			anomalies.push(row);
		}
		// else: row.lang === 'fr' with count >= 3 — already correct, no action.
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
			console.log(`  "${row.name}" (#${row.term_id}, slug ${row.slug}, ${row.count} article(s), lang=${row.lang})`);
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
			console.log(`  "${row.name}" (#${row.term_id}, slug ${row.slug}, ${row.count} article(s), lang=${row.lang ?? '(vide)'})`);
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
