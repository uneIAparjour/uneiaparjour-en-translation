import * as wp from './lib/wp.js';

/**
 * One-off diagnostic (2026-08-19), v2: confirmed a freshly-created post has
 * no Polylang language yet, so Polylang treats it as the site default
 * language and silently swaps any EN-language category assigned at
 * creation time for its FR counterpart (found live: creating a post with
 * categories:[431] came back as categories:[10], even before /link ran).
 *
 * This tests the fix: create WITHOUT categories, link translations first
 * (which sets the post's language to 'en' via pll_set_post_language), THEN
 * set categories in a separate update call — once the post's language is
 * actually 'en', Polylang should accept the EN-language term.
 *
 * Creates two throwaway draft posts (not linked to anything real), then
 * deletes both.
 *
 * Run: node debug-link-categories.js
 */
async function main() {
	console.log('Creating throwaway FR test post...');
	const frPost = await wp.createPost({ title: 'DEBUG TEST FR (safe to delete)', status: 'draft', content: 'test' });
	console.log(`  FR test post: #${frPost.id}`);

	console.log('Creating throwaway EN test post WITHOUT categories...');
	const enPost = await wp.createPost({ title: 'DEBUG TEST EN (safe to delete)', status: 'draft', content: 'test' });
	console.log(`  EN test post: #${enPost.id}`);

	console.log('Linking as FR/EN translations (sets language to en)...');
	await wp.linkTranslations(frPost.id, enPost.id);

	console.log('Now setting categories: [431] via a separate update call...');
	await wp.updatePost(enPost.id, { categories: [431] });

	const after = await wp.getPost(enPost.id);
	console.log('Categories AFTER language-then-categories:', JSON.stringify(after.categories));

	const worked = JSON.stringify(after.categories) === JSON.stringify([431]);
	console.log(worked ? '\n>>> FIX CONFIRMED: categories stuck as [431].' : '\n>>> Still broken.');

	console.log('\nCleaning up test posts...');
	await wp.deletePost(frPost.id);
	await wp.deletePost(enPost.id);
	console.log('Done.');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
