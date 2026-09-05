import * as wp from './lib/wp.js';
import { loadState } from './lib/state.js';

/**
 * Publishes translated Focus EN drafts — same logic as publish.js, kept as a
 * separate file because it reads state/focus-translations.json instead of
 * the main translations.json (see translate-focus.js for why this pipeline
 * is split off). Idempotent: only touches drafts this pipeline's own state
 * recognizes as a completed translation.
 *
 * Run: node publish-focus.js [--dry-run] [--limit=N]  (default limit: 15)
 */
const STATE_FILE = 'focus-translations.json';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit='));
const BATCH_SIZE = limitArg ? parseInt(limitArg.split('=')[1], 10) : 15;

async function main() {
	const state = await loadState(STATE_FILE);
	const translatedEnIds = new Set(
		Object.values(state)
			.filter((entry) => entry.status === 'translated' && entry.en_id)
			.map((entry) => entry.en_id)
	);

	console.log('Fetching draft EN posts...');
	const draftPosts = await wp.listAllPosts('draft');
	const readyToPublish = draftPosts.filter((p) => translatedEnIds.has(p.id));

	console.log(
		`${draftPosts.length} draft(s) total, ${readyToPublish.length} match a completed Focus translation in state.`
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
