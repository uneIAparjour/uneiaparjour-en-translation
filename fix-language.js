/**
 * One-off migration (2026-08-17): Polylang was configured with English as
 * the only/default language, so all ~1329 existing FR-content posts ended
 * up tagged "en". This corrects them to "fr" now that French has been
 * added and set as the default language.
 *
 * Requires the calling account to have edit_others_posts (Editor+) — the
 * translation-bot account is normally Author-only and must be temporarily
 * promoted to Editor to run this, then demoted back afterward.
 *
 * Not part of the regular pipeline — run once, by hand, then this file can
 * be deleted (kept for now as a record of what was done and why).
 */
import * as wp from './lib/wp.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	console.log('Fetching all posts...');
	const posts = await wp.listAllPosts();
	console.log(`${posts.length} posts found. Setting language to "fr" for all of them...`);

	let ok = 0;
	const failures = [];

	for (const post of posts) {
		try {
			await wp.setLanguage(post.id, 'fr');
			ok += 1;
			if (ok % 100 === 0) {
				console.log(`${ok}/${posts.length} done...`);
			}
		} catch (err) {
			console.error(`Post #${post.id} (${post.slug}) failed: ${err.message}`);
			failures.push({ id: post.id, slug: post.slug, error: err.message });
		}
		await sleep(120); // courtesy delay, shared hosting
	}

	console.log(`Done. ${ok} succeeded, ${failures.length} failed.`);
	if (failures.length > 0) {
		console.log('Failures:', JSON.stringify(failures, null, 2));
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
