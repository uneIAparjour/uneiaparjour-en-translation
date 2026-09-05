import * as wp from './lib/wp.js';
import { translateBatch } from './lib/azure.js';
import {
	splitBlocks,
	wrapGutenberg,
	rewriteInternalLinks,
	fixMediaBlocksFromSource,
	stripFigurePlaceholders,
	restoreFigurePlaceholders,
} from './lib/content.js';
import { mapTerms } from './lib/taxonomy.js';
import { loadState, saveState, hashSource } from './lib/state.js';
import { readFile } from 'node:fs/promises';

/**
 * Translates the site's "Focus" editorial articles (category id 50, slug
 * focus-lettre — the weekly reflection piece tied to each newsletter issue)
 * into EN. Deliberately a SEPARATE pipeline from translate.js: Focus posts
 * are explicitly excluded from that script's scope (see loadAllowedSlugs()'s
 * comment in toolsDataset.js) because they aren't tool reviews and must
 * never be added to the base/base-en tools dataset. This script never
 * touches that dataset or translations.json — its own progress lives in
 * state/focus-translations.json.
 *
 * Structure mirrors translate.js closely on purpose (same content pipeline,
 * same safety rails: content hashing to skip unchanged posts, _translation_locked
 * to never clobber a manual edit, slug-map internal link rewriting, draft-first
 * creation). Only the FR source selection differs: category membership
 * instead of the tools-dataset CSV.
 */

const FOCUS_CATEGORY_ID = 50;
const STATE_FILE = 'focus-translations.json';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const onlyFrIdArg = args.find((a) => a.startsWith('--only-fr-id='));
const ONLY_FR_IDS = onlyFrIdArg
	? new Set(
			onlyFrIdArg
				.split('=')[1]
				.split(',')
				.map((s) => parseInt(s.trim(), 10))
				.filter((n) => !Number.isNaN(n))
		)
	: null;
const limitArg = args.find((a) => a.startsWith('--limit='));
const BATCH_SIZE = limitArg ? parseInt(limitArg.split('=')[1], 10) : 15;

const stripHtml = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadGlossary() {
	const raw = await readFile(new URL('./config/glossary.json', import.meta.url), 'utf8');
	return JSON.parse(raw);
}

async function loadCategoryTranslations() {
	const raw = await readFile(new URL('./config/category-translations.json', import.meta.url), 'utf8');
	return JSON.parse(raw);
}

function buildTermLookup(terms) {
	const map = new Map();
	for (const t of terms) {
		map.set(t.id, t.name);
	}
	return map;
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

async function main() {
	const glossary = await loadGlossary();
	const categoryTranslations = await loadCategoryTranslations();
	const state = await loadState(STATE_FILE);
	const knownEnIds = new Set(Object.values(state).map((s) => s.en_id).filter(Boolean));

	console.log('Fetching all FR posts...');
	const allPosts = await wp.listAllPosts();
	const frPosts = allPosts.filter((p) => !knownEnIds.has(p.id) && p.categories.includes(FOCUS_CATEGORY_ID));
	console.log(`${allPosts.length} posts total, ${frPosts.length} are Focus FR sources to process.`);

	const [allCategories, allTags] = await Promise.all([wp.listCategories(), wp.listTags()]);
	const categoryNames = buildTermLookup(allCategories);
	const tagNames = buildTermLookup(allTags);

	const todo = [];
	for (const post of frPosts) {
		const title = stripHtml(post.title.rendered);
		const content = post.content.rendered;
		const yoastTitle = post.yoast_title || '';
		const yoastMetadesc = post.yoast_metadesc || '';
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

	const scopedTodo = ONLY_FR_IDS ? todo.filter((item) => ONLY_FR_IDS.has(item.post.id)) : todo;
	console.log(
		`${todo.length} Focus post(s) need (re)translation${
			ONLY_FR_IDS ? ` (${scopedTodo.length} match --only-fr-id out of ${ONLY_FR_IDS.size} requested)` : ''
		}, processing up to ${BATCH_SIZE} this run.`
	);
	const batch = ONLY_FR_IDS ? scopedTodo : scopedTodo.slice(0, BATCH_SIZE);

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
			await processPost(item, state, glossary, categoryNames, tagNames, slugMap, categoryTranslations);
			await saveState(state, STATE_FILE);
		} catch (err) {
			console.error(`FR #${post.id} failed: ${err.message}`);
			state[post.id] = {
				...(state[post.id] || {}),
				fr_slug: post.slug,
				status: 'failed',
				last_error: err.message,
				updated_at: new Date().toISOString(),
			};
			await saveState(state, STATE_FILE);
		}
		await sleep(500); // courtesy delay between posts, Azure F0's rate limit is strict
	}

	console.log('Batch done.');
}

async function processPost(item, state, glossary, categoryNames, tagNames, slugMap, categoryTranslations) {
	const { post, title, content, yoastTitle, yoastMetadesc, currentHash } = item;
	const existing = state[post.id];

	if (existing && existing.en_id) {
		const enPost = await wp.getPost(existing.en_id);
		if (enPost.meta && enPost.meta._translation_locked) {
			console.log(`FR #${post.id}: EN post ${existing.en_id} is locked (manually edited), skipping.`);
			state[post.id] = { ...existing, status: 'locked_skip', updated_at: new Date().toISOString() };
			return;
		}
	}

	console.log(`FR #${post.id} "${title}": translating...`);

	const {
		text: contentForTranslation,
		blocks: contentBlocks,
		placeholders: figurePlaceholders,
	} = stripFigurePlaceholders(content);

	const fields = ['title', 'content', 'yoastTitle', 'yoastMetadesc'];
	const values = [title, contentForTranslation, yoastTitle, yoastMetadesc];
	const nonEmpty = values
		.map((value, index) => ({ value, field: fields[index] }))
		.filter((entry) => entry.value);

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
		const CONTENT_HARD_CAP = 45000;
		if (contentEntry.value.length > CONTENT_HARD_CAP) {
			const chunks = [];
			let current = [];
			let currentLength = 0;
			for (const blockText of contentBlocks) {
				if (currentLength + blockText.length > CONTENT_HARD_CAP && current.length > 0) {
					chunks.push(current.join('\n\n'));
					current = [];
					currentLength = 0;
				}
				current.push(blockText);
				currentLength += blockText.length;
			}
			if (current.length > 0) {
				chunks.push(current.join('\n\n'));
			}

			const translatedChunks = [];
			for (const chunk of chunks) {
				const [translated] = await translateBatch([chunk], { isHtml: true, glossary });
				translatedChunks.push(translated);
			}
			translatedByField.content = translatedChunks.join('\n\n');
		} else {
			const [contentTranslated] = await translateBatch([contentEntry.value], { isHtml: true, glossary });
			translatedByField.content = contentTranslated;
		}
	} else {
		const translatedValues =
			nonEmpty.length > 0 ? await translateBatch(nonEmpty.map((entry) => entry.value), { isHtml: true, glossary }) : [];
		nonEmpty.forEach((entry, i) => {
			translatedByField[entry.field] = translatedValues[i];
		});
	}

	const translatedTitle = translatedByField.title || '';
	const translatedContent = restoreFigurePlaceholders(translatedByField.content || '', figurePlaceholders);
	const translatedYoastTitle = translatedByField.yoastTitle || '';
	const translatedYoastMetadesc = translatedByField.yoastMetadesc || '';

	const linkedContent = rewriteInternalLinks(translatedContent, slugMap);
	const draftContent = wrapGutenberg(splitBlocks(linkedContent));
	const finalContent = fixMediaBlocksFromSource(post.raw_content || '', draftContent).result;

	const { categories: enCategories, tags: enTags } = await mapTerms(
		{
			categories: post.categories.map((id) => ({ id, name: categoryNames.get(id) || String(id) })),
			tags: post.tags.map((id) => ({ id, name: tagNames.get(id) || String(id) })),
		},
		glossary,
		categoryTranslations
	);

	const isNewPost = !(existing && existing.en_id);

	const payload = {
		title: translatedTitle,
		content: finalContent,
		...(isNewPost ? { status: 'draft' } : {}),
		...(isNewPost ? { date: post.date, date_gmt: post.date_gmt } : {}),
		featured_media: post.featured_media || 0,
		...(isNewPost ? {} : { categories: enCategories, tags: enTags }),
		meta: {
			_translation_source_hash: currentHash,
			_translation_locked: false,
		},
		yoast_title: translatedYoastTitle,
		yoast_metadesc: translatedYoastMetadesc,
	};

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

	if (isNewPost) {
		await wp.updatePost(enId, { categories: enCategories, tags: enTags });
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

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
