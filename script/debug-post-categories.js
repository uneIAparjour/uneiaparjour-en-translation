import * as wp from './lib/wp.js';

/**
 * One-off read-only diagnostic (2026-08-19): the EN posts list in wp-admin
 * showed French category names (with accents, e.g. "présentation") on
 * freshly-created EN posts, right after switching the Translator resource
 * to S1. Suspected cause: config/taxonomy-map.json has cache entries left
 * over from before today's category dedup, some pointing at now-deleted
 * duplicate term ids — but resolveTerm() in taxonomy.js trusts the cache
 * blindly and never validates the target term still exists, so this can't
 * be confirmed by reading the cache file alone. This script asks WordPress
 * directly, via the same /term-audit endpoint the dedup tooling uses, for
 * ground truth: exactly which category ids each of the newest EN posts
 * actually carries, and each one's real Polylang language.
 *
 * Read-only. Makes no writes.
 *
 * Run: node debug-post-categories.js <en_post_id>[,<en_post_id>...]
 */
const idsArg = process.argv[2];
if (!idsArg) {
	console.error('Usage: node debug-post-categories.js <en_post_id>[,<en_post_id>...]');
	process.exit(1);
}
const postIds = idsArg
	.split(',')
	.map((s) => parseInt(s.trim(), 10))
	.filter((n) => !Number.isNaN(n));

async function main() {
	const [categoryRows, tagRows] = await Promise.all([wp.termAudit('category'), wp.termAudit('post_tag')]);
	const termById = new Map();
	for (const row of [...categoryRows, ...tagRows]) {
		termById.set(row.term_id, { name: row.name, lang: row.lang });
	}

	for (const id of postIds) {
		const post = await wp.getPost(id);
		const title = post.title?.rendered || post.title || '(sans titre)';
		console.log(`\nEN #${id} "${title}"`);

		console.log('  Categories:');
		for (const catId of post.categories || []) {
			const term = termById.get(catId);
			if (!term) {
				console.log(`    #${catId} -> INTROUVABLE (terme supprimé ou id invalide)`);
			} else {
				const flag = term.lang === 'en' ? '' : '  <-- PROBLEME: pas en anglais';
				console.log(`    #${catId} "${term.name}" (lang=${term.lang ?? '(vide)'})${flag}`);
			}
		}

		console.log('  Tags:');
		if (!post.tags || post.tags.length === 0) {
			console.log('    (aucun)');
		}
		for (const tagId of post.tags || []) {
			const term = termById.get(tagId);
			if (!term) {
				console.log(`    #${tagId} -> INTROUVABLE (terme supprimé ou id invalide)`);
			} else {
				const flag = term.lang === 'en' ? '' : '  <-- PROBLEME: pas en anglais';
				console.log(`    #${tagId} "${term.name}" (lang=${term.lang ?? '(vide)'})${flag}`);
			}
		}
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
