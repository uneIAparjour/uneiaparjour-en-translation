/**
 * One-off cleanup (2026-08-28): 6 EN posts got duplicated. Root cause:
 * these 6 FR articles were translated by an old, interrupted run (same
 * class of bug as the 27-orphan-drafts incident, 2026-08-24) — but unlike
 * those 27, these 6 were already PUBLISHED by the time of that incident's
 * investigation (which only scanned drafts), so they were invisible to
 * that scan and never got backfilled into state/translations.json. The
 * 2026-08-25 cron run (first one after the outage fix) treated them as
 * never-translated and created a second, duplicate EN post for each.
 * ResearchDeck is a special case: its correct post (id 19079) was
 * rebuilt by hand by the user (author #1, not translation-bot), which is
 * why it wasn't caught by the widened orphan scan either (that scan only
 * looks at translation-bot's own posts).
 *
 * This script has the 6 pairs hardcoded (verified live via the WP REST
 * API before writing this) — no date-matching heuristics needed, unlike
 * the general-purpose repair-orphan-drafts.js:
 *   fr_id -> {keep: en_id to backfill into state, trash: duplicate en_id to remove}
 *
 * --dry-run (default): print the plan, write nothing.
 * --apply: trash the duplicate posts and write state/translations.json.
 *
 * Run: node cleanup-duplicate-posts.js [--apply]
 */
import * as wp from './lib/wp.js';
import { loadState, saveState, hashSource } from './lib/state.js';

const APPLY = process.argv.includes('--apply');
const stripHtml = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const PAIRS = [
	{ fr_id: 17354, keep_en_id: 18793, trash_en_id: 19101, name: 'PDFFly PDF summarizer' },
	{ fr_id: 17336, keep_en_id: 18794, trash_en_id: 19103, name: 'Inkfox AI' },
	{ fr_id: 17287, keep_en_id: 18795, trash_en_id: 19105, name: 'ChordGen' },
	{ fr_id: 17272, keep_en_id: 18796, trash_en_id: 19107, name: 'Open Paper' },
	{ fr_id: 17255, keep_en_id: 18798, trash_en_id: 19110, name: 'InfoBlog' },
	{ fr_id: 19081, keep_en_id: 19079, trash_en_id: 19099, name: 'ResearchDeck' },
];

async function main() {
	const state = await loadState();

	for (const pair of PAIRS) {
		const frPost = await wp.getPost(pair.fr_id);
		const keepPost = await wp.getPost(pair.keep_en_id);
		const trashPost = await wp.getPost(pair.trash_en_id);

		const title = stripHtml(frPost.title.rendered);
		const content = frPost.content.rendered;
		const yoastTitle = frPost.yoast_title || '';
		const yoastMetadesc = frPost.yoast_metadesc || '';
		const sourceHash = hashSource({ title, content: frPost.raw_content || content, yoastTitle, yoastMetadesc });

		console.log(`\n${pair.name} (FR #${pair.fr_id}, /${frPost.slug}/)`);
		console.log(`  KEEP:  EN #${pair.keep_en_id} (/${keepPost.slug}/, status=${keepPost.status}, author=${keepPost.author})`);
		console.log(`  TRASH: EN #${pair.trash_en_id} (/${trashPost.slug}/, status=${trashPost.status}, author=${trashPost.author})`);
		console.log(`  state entry: fr #${pair.fr_id} -> en_id=${pair.keep_en_id}, source_hash=${sourceHash.slice(0, 12)}...`);

		if (APPLY) {
			await wp.updatePost(pair.trash_en_id, { status: 'trash' });
			state[pair.fr_id] = {
				fr_slug: frPost.slug,
				en_id: pair.keep_en_id,
				en_slug: keepPost.slug,
				source_hash: sourceHash,
				status: 'translated',
				last_error: null,
				updated_at: new Date().toISOString(),
			};
		}
	}

	if (!APPLY) {
		console.log('\nDRY RUN: nothing written. Re-run with --apply to trash duplicates and update state.');
		return;
	}

	await saveState(state);
	console.log('\nDone. Duplicates trashed, state/translations.json updated.');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
