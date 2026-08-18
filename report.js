import * as wp from './lib/wp.js';
import { loadState } from './lib/state.js';
import { loadAllowedSlugs } from './lib/toolsDataset.js';

/**
 * Read-only status report: cross-references the 1275-tool dataset against
 * the live WP posts and the pipeline's own state, so gaps are visible
 * without manually comparing 1275 rows by hand. Never writes anything.
 *
 * Run: node report.js
 */
async function main() {
	console.log('Fetching dataset, WP posts, and state...');
	const [allowedSlugs, allPosts, state] = await Promise.all([loadAllowedSlugs(), wp.listAllPosts(), loadState()]);

	const knownEnIds = new Set(Object.values(state).map((s) => s.en_id).filter(Boolean));
	// Same "what counts as an FR source post" logic as translate.js: any WP
	// post in the tools dataset that isn't itself a known EN translation.
	const frPostsBySlug = new Map();
	for (const post of allPosts) {
		if (knownEnIds.has(post.id)) continue;
		if (!allowedSlugs.has(post.slug)) continue;
		frPostsBySlug.set(post.slug, post);
	}

	const translated = [];
	const failed = [];
	const lockedSkip = [];
	const neverAttempted = [];
	const missingFromWp = [];

	for (const slug of allowedSlugs) {
		const post = frPostsBySlug.get(slug);
		if (!post) {
			// In the dataset but no matching FR post found in WP under this
			// slug — either the slug changed on the FR side since the dataset
			// snapshot, or the post was deleted/unpublished.
			missingFromWp.push(slug);
			continue;
		}
		const entry = state[post.id];
		if (!entry) {
			neverAttempted.push({ slug, id: post.id });
		} else if (entry.status === 'translated') {
			translated.push({ slug, id: post.id });
		} else if (entry.status === 'failed') {
			failed.push({ slug, id: post.id, error: entry.last_error });
		} else if (entry.status === 'locked_skip') {
			lockedSkip.push({ slug, id: post.id });
		} else {
			neverAttempted.push({ slug, id: post.id }); // unknown/unexpected status, treat as not done
		}
	}

	console.log('');
	console.log('=== Rapport de couverture ===');
	console.log(`Dataset (base officielle) : ${allowedSlugs.size} outils`);
	console.log(`  Traduits             : ${translated.length}`);
	console.log(`  Echoues              : ${failed.length}`);
	console.log(`  Verrouilles (manuel) : ${lockedSkip.length}`);
	console.log(`  Jamais traites       : ${neverAttempted.length}`);
	console.log(`  Introuvables sur WP  : ${missingFromWp.length}`);
	const total = translated.length + failed.length + lockedSkip.length + neverAttempted.length + missingFromWp.length;
	console.log(`  Total verifie        : ${total} / ${allowedSlugs.size}`);

	if (failed.length > 0) {
		console.log('');
		console.log('--- Echoues (a corriger ou relancer) ---');
		for (const f of failed) {
			console.log(`  FR #${f.id} /${f.slug}/ : ${f.error}`);
		}
	}

	if (missingFromWp.length > 0) {
		console.log('');
		console.log('--- Introuvables sur WP (verifier a la main) ---');
		for (const slug of missingFromWp) {
			console.log(`  /${slug}/`);
		}
	}

	if (neverAttempted.length > 0 && neverAttempted.length <= 50) {
		console.log('');
		console.log('--- Jamais traites (seront pris au prochain run) ---');
		for (const n of neverAttempted) {
			console.log(`  FR #${n.id} /${n.slug}/`);
		}
	} else if (neverAttempted.length > 50) {
		console.log('');
		console.log(`--- ${neverAttempted.length} jamais traites (liste non affichee, trop longue) ---`);
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
