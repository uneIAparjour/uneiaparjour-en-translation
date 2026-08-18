import { readFile } from 'node:fs/promises';
import * as wp from './lib/wp.js';
import { translateBatch } from './lib/azure.js';
import { splitBlocks, wrapGutenberg, rewriteInternalLinks } from './lib/content.js';
import { mapTerms } from './lib/taxonomy.js';
import { loadState, saveState, hashSource } from './lib/state.js';
import { loadAllowedSlugs } from './lib/toolsDataset.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const REPAIR_LINKS = args.includes('--repair-links');
const REPAIR_IMAGES = args.includes('--repair-images');
const limitArg = args.find((a) => a.startsWith('--limit='));
const BATCH_SIZE = limitArg ? parseInt(limitArg.split('=')[1], 10) : 15;

const stripHtml = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadGlossary() {
	const raw = await readFile(new URL('./config/glossary.json', import.meta.url), 'utf8');
	return JSON.parse(raw);
}

function buildTermLookup(terms) {
	const map = new Map();
	for (const t of terms) {
		map.set(t.id, t.name);
	}
	return map;
}

async function main() {
	const glossary = await loadGlossary();
	const state = await loadState();
	const knownEnIds = new Set(Object.values(state).map((s) => s.en_id).filter(Boolean));

	if (REPAIR_LINKS) {
		await repairLinks(state);
		return;
	}

	if (REPAIR_IMAGES) {
		await repairImages(state);
		return;
	}

	console.log(`Fetching all FR posts...`);
	const allPosts = await wp.listAllPosts();
	const allowedSlugs = await loadAllowedSlugs();
	const frPosts = allPosts.filter((p) => !knownEnIds.has(p.id) && allowedSlugs.has(p.slug));
	const excludedCount = allPosts.length - frPosts.length - knownEnIds.size;
	console.log(
		`${allPosts.length} posts total, ${allowedSlugs.size} in the tools dataset, ${frPosts.length} are FR sources to process (${excludedCount} posts excluded — not in the dataset, e.g. newsletter/focus/lecture content).`
	);

	const [allCategories, allTags] = await Promise.all([wp.listCategories(), wp.listTags()]);
	const categoryNames = buildTermLookup(allCategories);
	const tagNames = buildTermLookup(allTags);

	const todo = [];
	for (const post of frPosts) {
		const title = stripHtml(post.title.rendered);
		const content = post.content.rendered;
		const yoastTitle = post.yoast_title || '';
		const yoastMetadesc = post.yoast_metadesc || '';
		// Hash content.raw (via the plugin's raw_content field), not
		// content.rendered — the rendered HTML is unstable between requests
		// for the same unchanged post (WP core's image lightbox injects
		// randomized IDs at render time), which made every post look
		// "changed" on every run. content.rendered is still what gets
		// translated below — just not what detects change.
		const currentHash = hashSource({ title, content: post.raw_content || content, yoastTitle, yoastMetadesc });

		const existing = state[post.id];
		if (existing && existing.source_hash === currentHash) {
			continue; // already up to date
		}
		if (existing && existing.status === 'locked_skip') {
			continue; // was manually edited on the EN side, needs human review, never auto-touch
		}
		todo.push({ post, title, content, yoastTitle, yoastMetadesc, currentHash });
	}

	console.log(`${todo.length} post(s) need (re)translation, processing up to ${BATCH_SIZE} this run.`);
	const batch = todo.slice(0, BATCH_SIZE);

	if (DRY_RUN) {
		for (const { post, title } of batch) {
			const action = state[post.id] ? 'would UPDATE' : 'would CREATE';
			console.log(`[dry-run] ${action} EN post for FR #${post.id} "${title}" (/${post.slug}/)`);
		}
		console.log(`[dry-run] No changes written. ${batch.length} post(s) would be processed.`);
		return;
	}

	const slugMap = buildSlugMap(state);

	for (const item of batch) {
		const { post } = item;
		try {
			await processPost(item, state, glossary, categoryNames, tagNames, slugMap);
			await saveState(state); // persist after every post, not just at the end, so a crash mid-batch doesn't lose progress
		} catch (err) {
			console.error(`FR #${post.id} failed: ${err.message}`);
			state[post.id] = {
				...(state[post.id] || {}),
				fr_slug: post.slug,
				status: 'failed',
				last_error: err.message,
				updated_at: new Date().toISOString(),
			};
			await saveState(state);
		}
		await sleep(500); // courtesy delay between posts, Azure F0's rate limit is strict
	}

	console.log('Batch done.');
}

function buildSlugMap(state) {
	const map = new Map();
	for (const entry of Object.values(state)) {
		if (entry.en_slug && entry.status === 'translated') {
			map.set(entry.fr_slug, entry.en_slug);
		}
	}
	return map;
}

async function processPost(item, state, glossary, categoryNames, tagNames, slugMap) {
	const { post, title, content, yoastTitle, yoastMetadesc, currentHash } = item;
	const existing = state[post.id];

	// If we're updating an existing EN post, never overwrite a manual human edit.
	if (existing && existing.en_id) {
		const enPost = await wp.getPost(existing.en_id);
		if (enPost.meta && enPost.meta._translation_locked) {
			console.log(`FR #${post.id}: EN post ${existing.en_id} is locked (manually edited), skipping.`);
			state[post.id] = { ...existing, status: 'locked_skip', updated_at: new Date().toISOString() };
			return;
		}
	}

	console.log(`FR #${post.id} "${title}": translating...`);

	// One Azure call for all four texts, not four parallel calls — F0's rate
	// limit reliably 429s on 4 simultaneous requests per post (found during
	// the first live test). tag_handling=html is safe for the plain-text
	// fields too (no markup to mistranslate), so they can share the request.
	const fields = ['title', 'content', 'yoastTitle', 'yoastMetadesc'];
	const values = [title, content, yoastTitle, yoastMetadesc];
	const nonEmpty = values
		.map((value, index) => ({ value, field: fields[index] }))
		.filter((entry) => entry.value);

	// Azure's hard cap is 50,000 characters across the whole request array,
	// and glossary dictionary-wrapping adds further overhead on top of the
	// raw length — found live on FR #18075 "ResearchDeck" (an unusually long
	// article), which hit "400077 The maximum request size has been
	// exceeded" when batched normally. Rare — most articles are short — so
	// only fall back to a separate call for `content` (virtually always the
	// large field) above a conservative threshold, keeping the common case
	// at one call.
	const CONTENT_SIZE_THRESHOLD = 20000;
	const totalLength = nonEmpty.reduce((sum, entry) => sum + entry.value.length, 0);
	const translatedByField = {};

	if (totalLength > CONTENT_SIZE_THRESHOLD && nonEmpty.some((entry) => entry.field === 'content')) {
		const contentEntry = nonEmpty.find((entry) => entry.field === 'content');
		const others = nonEmpty.filter((entry) => entry.field !== 'content');
		if (others.length > 0) {
			const othersTranslated = await translateBatch(others.map((entry) => entry.value), { isHtml: true, glossary });
			others.forEach((entry, i) => {
				translatedByField[entry.field] = othersTranslated[i];
			});
		}
		const [contentTranslated] = await translateBatch([contentEntry.value], { isHtml: true, glossary });
		translatedByField.content = contentTranslated;
	} else {
		const translatedValues =
			nonEmpty.length > 0 ? await translateBatch(nonEmpty.map((entry) => entry.value), { isHtml: true, glossary }) : [];
		nonEmpty.forEach((entry, i) => {
			translatedByField[entry.field] = translatedValues[i];
		});
	}

	const translatedTitle = translatedByField.title || '';
	const translatedContent = translatedByField.content || '';
	const translatedYoastTitle = translatedByField.yoastTitle || '';
	const translatedYoastMetadesc = translatedByField.yoastMetadesc || '';

	const linkedContent = rewriteInternalLinks(translatedContent, slugMap);
	const finalContent = wrapGutenberg(splitBlocks(linkedContent));

	const { categories: enCategories, tags: enTags } = await mapTerms(
		{
			categories: post.categories.map((id) => ({ id, name: categoryNames.get(id) || String(id) })),
			tags: post.tags.map((id) => ({ id, name: tagNames.get(id) || String(id) })),
		},
		glossary
	);

	const isNewPost = !(existing && existing.en_id);

	const payload = {
		title: translatedTitle,
		content: finalContent,
		// Only force draft status on first creation — human review gate per
		// phases 04/05. On a re-sync (FR source changed after the EN post
		// already exists), status is deliberately omitted so an already-
		// published EN post stays published instead of being reverted to draft.
		...(isNewPost ? { status: 'draft' } : {}),
		// Match the FR post's original publish date on creation (site's whole
		// identity is "one AI tool per day" — the EN version should say the
		// same day, not the translation date). Set explicitly here, one
		// direction only, never touching the FR post — NOT via Polylang's
		// own date-sync setting, which was found to sync backwards (EN's
		// creation date overwriting the FR original) and got disabled.
		...(isNewPost ? { date: post.date, date_gmt: post.date_gmt } : {}),
		featured_media: post.featured_media || 0,
		categories: enCategories,
		tags: enTags,
		meta: {
			_translation_source_hash: currentHash,
			_translation_locked: false,
		},
		yoast_title: translatedYoastTitle,
		yoast_metadesc: translatedYoastMetadesc,
	};

	// Deliberately NOT setting payload.slug = post.slug here (as an earlier
	// version did). Copying the FR slug always collided with the FR post and
	// got "-2" appended by WP — confirmed unfixable even via Polylang's own
	// native "add translation" UI (2026-08-17 live testing), so trying to
	// match the FR slug is a dead end regardless of approach. It was also
	// actively wrong for FR titles that are French descriptive phrases
	// rather than bare product names (e.g. "Aperçu IA de Google" -> "Google
	// AI Preview"): reusing the FR slug left French text in the URL of an
	// English post. Leaving slug unset lets WordPress generate it from the
	// translated title instead, fixing that case with a clean English URL.
	// Note this does NOT eliminate "-2" for the common case where the title
	// is just the tool's own name unchanged in both languages (e.g. "T3
	// Chat") — FR and EN still generate the identical slug there, so the
	// same collision (and "-2") still happens; only the mixed-phrase titles
	// benefit. Accepted anyway, same as the rest of this slug limitation.
	let enId;
	if (isNewPost) {
		const created = await wp.createPost(payload);
		enId = created.id;
		console.log(`FR #${post.id}: created EN post ${enId}.`);
	} else {
		await wp.updatePost(existing.en_id, payload);
		enId = existing.en_id;
		console.log(`FR #${post.id}: updated existing EN post ${enId}.`);
	}

	await wp.linkTranslations(post.id, enId);

	const enPostFinal = await wp.getPost(enId);
	state[post.id] = {
		fr_slug: post.slug,
		en_id: enId,
		en_slug: enPostFinal.slug,
		source_hash: currentHash,
		status: 'translated',
		last_error: null,
		updated_at: new Date().toISOString(),
	};
	slugMap.set(post.slug, enPostFinal.slug);
}

/**
 * Re-scans already-translated EN posts and re-applies internal link
 * rewriting using the current (more complete) slug map, fixing links that
 * degraded to their FR target because the destination wasn't translated yet
 * at the time. Meant to be run periodically, e.g. once the backlog empties out.
 */
async function repairLinks(state) {
	const slugMap = buildSlugMap(state);
	let updatedCount = 0;

	for (const [frId, entry] of Object.entries(state)) {
		if (entry.status !== 'translated' || !entry.en_id) {
			continue;
		}
		const enPost = await wp.getPost(entry.en_id);
		if (enPost.meta && enPost.meta._translation_locked) {
			continue; // don't touch manually-edited posts even for link repair
		}
		const repaired = rewriteInternalLinks(enPost.content.rendered, slugMap);
		if (repaired !== enPost.content.rendered) {
			await wp.updatePost(entry.en_id, { content: repaired });
			updatedCount += 1;
			console.log(`Repaired links in EN post ${entry.en_id} (FR #${frId}).`);
		}
	}

	console.log(`Link repair done: ${updatedCount} post(s) updated.`);
}

/**
 * Re-scans already-translated EN posts and upgrades any image wrapped as a
 * generic wp:html block (content.js's fallback before the lightbox fix,
 * 2026-08-18) into a proper wp:image block with lightbox explicitly
 * disabled, matching FR — patches the stored block markup directly via
 * raw_content, no re-translation needed. Posts translated after the fix
 * already have this; running it again is a safe no-op for them.
 */
async function repairImages(state) {
	let updatedCount = 0;
	const pattern = /<!-- wp:html -->\s*(<figure\b[\s\S]*?<img\b[\s\S]*?<\/figure>)\s*<!-- \/wp:html -->/gi;

	for (const [frId, entry] of Object.entries(state)) {
		if (entry.status !== 'translated' || !entry.en_id) {
			continue;
		}
		const enPost = await wp.getPost(entry.en_id);
		if (enPost.meta && enPost.meta._translation_locked) {
			continue; // don't touch manually-edited posts, same as repairLinks()
		}
		const raw = enPost.raw_content || '';
		const repaired = raw.replace(
			pattern,
			(match, figureHtml) => `<!-- wp:image {"lightbox":{"enabled":false}} -->\n${figureHtml}\n<!-- /wp:image -->`
		);
		if (repaired !== raw) {
			await wp.updatePost(entry.en_id, { content: repaired });
			updatedCount += 1;
			console.log(`Repaired image block(s) in EN post ${entry.en_id} (FR #${frId}).`);
		}
	}

	console.log(`Image repair done: ${updatedCount} post(s) updated.`);
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
