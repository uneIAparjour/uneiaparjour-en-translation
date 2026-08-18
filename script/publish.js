import * as wp from './lib/wp.js';
import { loadState } from './lib/state.js';

/**
 * Publishes a controlled batch of already-translated EN drafts — a separate,
 * deliberate step from translate.js, which always creates drafts regardless
 * of how many previous batches were published (the human-review gate from
 * phases 04/05). Matches the plan's graduated SEO rollout (small daily
 * batches, never the whole backlog at once) instead of a single "publish
 * everything" action.
 *
 * Idempotent and safe to re-run: only touches posts still in "draft" status
 * that this pipeline's own state tracks as translated, so already-published
 * posts are never re-touched and a post published by hand outside this
 * script is simply skipped next time.
 *
 * Run: node publish.js [--dry-run] [--limit=N]  (default limit: 15)
 */
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit='));
const BATCH_SIZE = limitArg ? parseInt(limitArg.split('=')[1], 10) : 15;

async function main() {
	const state = await loadState();
	const translatedEnIds = new Set(
		Object.values(state)
			.filter((entry) => entry.status === 'translated' && entry.en_id)
			.map((entry) => entry.en_id)
	);

	console.log('Fetching draft EN posts...');
	const draftPosts = await wp.listAllPosts('draft');
	// Defense in depth: only ever publish posts this pipeline's own state
	// recognizes as a completed translation, never any other draft that
	// happens to belong to translation-bot for some other reason.
	const readyToPublish = draftPosts.filter((p) => translatedEnIds.has(p.id));

	console.log(
		`${draftPosts.length} draft(s) total, ${readyToPublish.length} match a completed translation in state.`
	);
	const batch = readyToPublish.slice(0, BATCH_SIZE);
	console.log(`Publishing ${batch.length} of ${readyToPublish.length} waiting.`);

	if (DRY_RUN) {
		for (const post of batch) {
			console.log(`[dry-run] Would publish EN #${post.id} "${post.title.rendered}" (/${post.slug}/)`);
		}
		console.log('[dry-run] Nothing written.');
		return;
	}

	let published = 0;
	for (const post of batch) {
		try {
			await wp.updatePost(post.id, { status: 'publish' });
			console.log(`EN #${post.id} "${post.title.rendered}": published.`);
			published += 1;
		} catch (err) {
			console.error(`EN #${post.id}: publish failed - ${err.message}`);
		}
	}

	console.log(`Done: ${published}/${batch.length} post(s) published.`);
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
