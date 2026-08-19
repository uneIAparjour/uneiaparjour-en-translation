import * as wp from './lib/wp.js';

/**
 * One-off diagnostic (2026-08-19): isolates whether linking two posts as
 * Polylang translations (tb_link_translations -> pll_set_post_language +
 * pll_save_post_translations) is what corrupts an EN post's categories
 * after they were correctly set at creation time. Every EN post created
 * tonight ended up with its FR category ids instead of the correct EN ones
 * that createOrGetTerm() (confirmed via debug-resolve-term.js) actually
 * resolves — the two known-safe pieces (term resolution, Polylang taxonomy
 * sync setting, which is off) don't explain it, so this checks the one
 * remaining step in translate.js's sequence: /link runs AFTER categories
 * are set on the new post.
 *
 * Creates two throwaway draft posts (not linked to anything real), checks
 * categories before and after linking them, then deletes both.
 *
 * Run: node debug-link-categories.js
 */
async function main() {
	console.log('Creating throwaway FR test post...');
	const frPost = await wp.createPost({ title: 'DEBUG TEST FR (safe to delete)', status: 'draft', content: 'test' });
	console.log(`  FR test post: #${frPost.id}`);

	console.log('Creating throwaway EN test post with categories: [431]...');
	const enPost = await wp.createPost({
		title: 'DEBUG TEST EN (safe to delete)',
		status: 'draft',
		content: 'test',
		categories: [431],
	});
	console.log(`  EN test post: #${enPost.id}`);

	const beforeLink = await wp.getPost(enPost.id);
	console.log('Categories BEFORE linking:', JSON.stringify(beforeLink.categories));

	console.log('Linking as FR/EN translations...');
	await wp.linkTranslations(frPost.id, enPost.id);

	const afterLink = await wp.getPost(enPost.id);
	console.log('Categories AFTER linking:', JSON.stringify(afterLink.categories));

	const changed = JSON.stringify(beforeLink.categories) !== JSON.stringify(afterLink.categories);
	console.log(changed ? '\n>>> CONFIRMED: linking changed the categories.' : '\n>>> Linking did NOT change the categories.');

	console.log('\nCleaning up test posts...');
	await wp.deletePost(frPost.id);
	await wp.deletePost(enPost.id);
	console.log('Done.');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
