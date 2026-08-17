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

	const translatedValues =
		nonEmpty.length > 0 ? await translateBatch(nonEmpty.map((entry) => entry.value), { isHtml: true, glossary }) : [];

	const translatedByField = {};
	nonEmpty.forEach((entry, i) => {
		translatedByField[entry.field] = translatedValues[i];
	});

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

	let enId;
	if (isNewPost) {
		payload.slug = post.slug;
		const created = await wp.createPost(payload);
		enId = created.id;
		console.log(`FR #${post.id}: created EN post ${enId}.`);
	} else {
		await wp.updatePost(existing.en_id, payload);
		enId = existing.en_id;
		console.log(`FR #${post.id}: updated existing EN post ${enId}.`);
	}

	await wp.linkTranslations(post.id, enId);

	// WP's slug-uniqueness check runs at creation time, before Polylang knows
	// this post is "en" (language is only set by the /link call just above),
	// so it sees a collision with the FR original and appends "-2". Polylang
	// allows identical slugs across languages once the language is actually
	// known — re-applying the clean slug now, after linking, lets it through.
	if (isNewPost) {
		const check = await wp.getPost(enId);
		if (check.slug !== post.slug) {
			await wp.updatePost(enId, { slug: post.slug });
			console.log(`FR #${post.id}: corrected EN slug "${check.slug}" -> "${post.slug}".`);
		}
	}

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

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
