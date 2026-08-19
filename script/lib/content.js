/**
 * Splits a flat sequence of top-level HTML block elements into an array of
 * { tag, html } entries. Matches this site's actual content shape (verified
 * empirically across ~20 real articles: simple flat paragraphs/lists/headings)
 * — not a general-purpose HTML/Gutenberg parser. figure is handled separately
 * below because it's the one tag that nests (a WP Gallery block is a <figure>
 * containing several child <figure><img></figure> elements) — a naive
 * non-greedy regex match stops at the first inner </figure>, leaving the
 * outer gallery tag unclosed (found live 2026-08-18 on a Vunote gallery,
 * surfaced as "contenu invalide" in the block editor).
 */
const SIMPLE_BLOCK_PATTERN = /<(p|h[1-6]|ul|ol|blockquote|table)\b[^>]*>[\s\S]*?<\/\1>/gi;
const FIGURE_TAG_PATTERN = /<(\/?)figure\b[^>]*>/gi;

function findBalancedFigureEnd(html, openIndex) {
	FIGURE_TAG_PATTERN.lastIndex = openIndex;
	let depth = 0;
	let match;
	while ((match = FIGURE_TAG_PATTERN.exec(html)) !== null) {
		depth += match[1] === '/' ? -1 : 1;
		if (depth === 0) {
			return match.index + match[0].length;
		}
	}
	return -1; // unbalanced input — caller should stop rather than loop forever
}

export function splitBlocks(html) {
	const blocks = [];
	let cursor = 0;
	while (cursor < html.length) {
		const figureIdx = html.indexOf('<figure', cursor);
		SIMPLE_BLOCK_PATTERN.lastIndex = cursor;
		const simpleMatch = SIMPLE_BLOCK_PATTERN.exec(html);

		if (figureIdx !== -1 && (!simpleMatch || figureIdx <= simpleMatch.index)) {
			const end = findBalancedFigureEnd(html, figureIdx);
			if (end === -1) break;
			blocks.push({ tag: 'figure', html: html.slice(figureIdx, end) });
			cursor = end;
			continue;
		}
		if (simpleMatch) {
			blocks.push({ tag: simpleMatch[1].toLowerCase(), html: simpleMatch[0] });
			cursor = simpleMatch.index + simpleMatch[0].length;
			continue;
		}
		break;
	}
	return blocks;
}

/**
 * Strips figure blocks (images/galleries) out of rendered HTML before it
 * goes to Azure, replacing each with a small HTML-comment placeholder.
 * Figures carry no translatable text on this site (image alt is always
 * empty) and their markup is what pushed several long articles over Azure's
 * 50,000-char request cap (found live 2026-08-19 on ResearchDeck: 104,635
 * chars of content, ~1,500 of which was actual prose — the rest was
 * gallery/lightbox boilerplate). It's pure waste even under the cap:
 * fixMediaBlocksFromSource() always discards whatever Azure did to figure
 * blocks anyway, replacing them with FR's raw source verbatim (images are
 * never translated) — so nothing is lost by not translating them in the
 * first place. HTML comments are the placeholder vehicle because Azure's
 * tag_handling=html mode translates text nodes only, leaving comments
 * untouched by design.
 */
export function stripFigurePlaceholders(html) {
	const placeholders = new Map();
	let i = 0;
	const blocks = splitBlocks(html).map((block) => {
		if (block.tag !== 'figure') {
			return block.html;
		}
		const key = `<!--FIGPLACEHOLDER${i}-->`;
		placeholders.set(key, block.html);
		i += 1;
		return key;
	});
	// `blocks` is exposed alongside the joined `text` so callers that need to
	// chunk an unusually large result (see translate.js's CONTENT_HARD_CAP)
	// can split along these exact boundaries instead of re-parsing `text`
	// with splitBlocks() — a second pass would silently drop the
	// "<!--FIGPLACEHOLDERn-->" comments (they match none of splitBlocks'
	// recognized tags), losing the figures they stand in for.
	return { text: blocks.join('\n\n'), blocks, placeholders };
}

export function restoreFigurePlaceholders(html, placeholders) {
	let result = html;
	for (const [key, original] of placeholders) {
		result = result.replace(key, original);
	}
	return result;
}

/**
 * Wraps each block in the Gutenberg block comments WordPress expects, so the
 * resulting post stays normally editable in the block editor instead of
 * showing up as unrecognized/classic content.
 */
export function wrapGutenberg(blocks) {
	return blocks
		.map(({ tag, html }) => {
			if (tag === 'p') {
				return `<!-- wp:paragraph -->\n${html}\n<!-- /wp:paragraph -->`;
			}
			if (/^h[1-6]$/.test(tag)) {
				const level = tag.slice(1);
				return `<!-- wp:heading {"level":${level}} -->\n${html}\n<!-- /wp:heading -->`;
			}
			if (tag === 'ul') {
				return `<!-- wp:list -->\n${html}\n<!-- /wp:list -->`;
			}
			if (tag === 'ol') {
				return `<!-- wp:list {"ordered":true} -->\n${html}\n<!-- /wp:list -->`;
			}
			if (tag === 'blockquote') {
				return `<!-- wp:quote -->\n${html}\n<!-- /wp:quote -->`;
			}
			if (tag === 'figure' && /wp-block-gallery/i.test(html)) {
				// A real WP Gallery block (2+ images grouped) — each child
				// image already carries its own baked-in lightbox markup (or
				// lack of it) from FR's rendered HTML, so preserving it as-is
				// inside a generic wp:html block displays identically to FR
				// without us needing to declare a single lightbox value for
				// a block that actually holds several images.
				return `<!-- wp:html -->\n${html}\n<!-- /wp:html -->`;
			}
			if (tag === 'figure' && /<img\b/i.test(html)) {
				// WordPress 6.4 added the image-block "lightbox" (click to
				// enlarge) feature, on by default for new blocks, retroactively
				// disabled on every pre-existing image block at rollout time.
				// That per-block enabled/disabled state only lives in the raw
				// block comment, not in content.rendered (all we have here),
				// so it's lost when reconstructing the block from scratch —
				// but it IS observable indirectly: WordPress only renders the
				// interactive lightbox wrapper (data-wp-interactive, the zoom
				// button) into content.rendered when the block's effective
				// lightbox setting is enabled. Detect that instead of
				// hardcoding false — a hardcoded false on a post created
				// after the feature's rollout (real lightbox: enabled) was
				// declaring the opposite of what the HTML actually contained,
				// which is what WordPress's block validator flagged as
				// "contenu invalide" (found live 2026-08-18 on Vunote).
				const lightboxEnabled = /data-wp-interactive="core\/image"|class="lightbox-trigger"/i.test(html);
				return `<!-- wp:image {"lightbox":{"enabled":${lightboxEnabled}}} -->\n${html}\n<!-- /wp:image -->`;
			}
			// Safe fallback for anything not explicitly mapped (table, a
			// figure without an <img>...): keep the markup working without
			// claiming a block type we're not sure of.
			return `<!-- wp:html -->\n${html}\n<!-- /wp:html -->`;
		})
		.join('\n\n');
}

/**
 * Replaces every image/gallery/video region in enRawContent with the
 * corresponding block(s) copied VERBATIM from frRawContent, matched by
 * <img>/<video> src (media is never translated — identical URLs, same
 * media library both languages). This is the root fix for the whole
 * image/gallery/video bug class found 2026-08-18 (lightbox "contenu
 * invalide", collapsed gallery columns, videos that don't play):
 * translate.js builds EN content from content.rendered — WordPress's
 * SERVER-RENDERED HTML, which bakes in the interactive lightbox wrapper
 * (data-wp-interactive, the zoom button) at render time. That markup was
 * never meant to be persisted as stored block content; it's regenerated by
 * WordPress on every render from the block's own minimal source markup —
 * which is exactly what raw_content already contains for FR. Storing the
 * rendered version as if it were the source was invalid by construction (no
 * declared attribute set produces that exact HTML) and also defeated WP's
 * dynamic gallery-column computation, which only runs for a block it
 * recognizes as valid. Superseded repairImageBlockMarkup() and
 * repairGalleryLayouts() (2026-08-18, earlier the same day) — those treated
 * the symptom (guessed a lightbox boolean, reassembled fragments) instead of
 * this root cause; this replaces both.
 */
const WP_GALLERY_PATTERN = /<!-- wp:gallery [^>]*-->[\s\S]*?<!-- \/wp:gallery -->/g;
// Matches any top-level block by comment, whatever its declared type — a
// backreference (\1) ties the closing comment to the same type as the
// opening one, so e.g. a wp:image block can never be mis-closed by an
// unrelated /wp:video. Needed because a video's block TYPE label can't be
// trusted: FR itself sometimes mislabels a video or audio embed as wp:image
// at authoring time (found live 2026-08-18 on LongCat-Video, Flow + Gemini
// Omni, and Kyutai Pocket TTS's audio samples — media pasted through a
// workflow that doesn't produce a real wp:video/wp:audio block), and EN
// inherits whatever mislabeling FR had *at translation time* even after FR
// itself later gets cleaned up to a proper wp:video/wp:audio block.
const ANY_BLOCK_PATTERN = /<!-- wp:([a-z][\w-]*(?:\/[\w-]+)?) ?[^>]*-->[\s\S]*?<!-- \/wp:\1 -->/g;
const HAS_MEDIA_SRC = /<(?:img|video|audio)\b[^>]*\bsrc="/i;

function extractTopLevelMediaBlocks(raw) {
	WP_GALLERY_PATTERN.lastIndex = 0;
	const galleries = [];
	let m;
	while ((m = WP_GALLERY_PATTERN.exec(raw)) !== null) {
		galleries.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
	}
	const insideGallery = (pos) => galleries.some((g) => pos >= g.start && pos < g.end);

	ANY_BLOCK_PATTERN.lastIndex = 0;
	const standaloneMedia = [];
	while ((m = ANY_BLOCK_PATTERN.exec(raw)) !== null) {
		if (m[1] === 'gallery' || !HAS_MEDIA_SRC.test(m[0]) || insideGallery(m.index)) {
			continue;
		}
		standaloneMedia.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
	}

	return [...galleries, ...standaloneMedia].sort((a, b) => a.start - b.start).map((b) => b.text);
}

export function fixMediaBlocksFromSource(frRawContent, enRawContent) {
	const frBlocks = extractTopLevelMediaBlocks(frRawContent);
	if (frBlocks.length === 0) {
		return { result: enRawContent, changed: false };
	}

	let result = enRawContent;
	let changed = false;

	for (const frBlock of frBlocks) {
		if (result.includes(frBlock)) {
			continue; // EN already has this exact FR block verbatim — idempotent no-op
		}
		const srcs = [...frBlock.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
		if (srcs.length === 0) {
			continue;
		}

		// Tier 1: a single existing top-level block (whatever type it's
		// currently labeled) whose content already contains every target
		// src. Covers a whole gallery that fell through wrapGutenberg's
		// generic wp:html fallback — the individual images inside aren't
		// separately wp:image-comment-wrapped in that case (they're bare
		// <figure> elements nested straight in the wp:html block), so
		// tier 2's per-image comment matching below can never see them
		// (found live 2026-08-19 on CoachLingo: 3 galleries silently
		// skipped this way, while a standalone wp:video right after them
		// in the same post was fixed correctly).
		ANY_BLOCK_PATTERN.lastIndex = 0;
		let singleBlockMatch = null;
		let anyMatch;
		while ((anyMatch = ANY_BLOCK_PATTERN.exec(result)) !== null) {
			if (srcs.every((src) => anyMatch[0].includes(`src="${src}"`))) {
				singleBlockMatch = { start: anyMatch.index, end: anyMatch.index + anyMatch[0].length };
				break;
			}
		}
		if (singleBlockMatch) {
			result = result.slice(0, singleBlockMatch.start) + frBlock + result.slice(singleBlockMatch.end);
			changed = true;
			continue;
		}

		// Tier 2: each target image sitting in its OWN separate top-level
		// block (the older "one gallery fragmented into standalone
		// sibling wp:image blocks" shape, from before today's splitBlocks
		// fix) — reassemble by finding each one individually and requiring
		// them to be contiguous.
		ANY_BLOCK_PATTERN.lastIndex = 0;
		const matches = [];
		let match;
		while ((match = ANY_BLOCK_PATTERN.exec(result)) !== null) {
			if (match[1] === 'gallery') {
				continue; // a real wp:gallery containing only SOME of the target srcs isn't this shape — skip, tier 1 already ruled out "contains all"
			}
			const src = (match[0].match(/src="([^"]+)"/) || [])[1];
			if (src && srcs.includes(src)) {
				matches.push({ src, start: match.index, end: match.index + match[0].length });
			}
		}

		if (matches.length !== srcs.length) {
			continue; // couldn't cleanly find every image for this block — skip rather than guess
		}
		matches.sort((a, b) => a.start - b.start);

		let contiguous = true;
		for (let i = 1; i < matches.length; i++) {
			const gap = result.slice(matches[i - 1].end, matches[i].start);
			if (gap.trim() !== '') {
				contiguous = false;
				break;
			}
		}
		if (!contiguous) {
			continue; // unexpected shape — skip rather than risk deleting unrelated content
		}

		let spanStart = matches[0].start;
		const spanEnd = matches[matches.length - 1].end;
		// A dangling unclosed gallery-wrapper opening tag can still sit
		// immediately before the first match if repairImageBlockMarkup
		// (an earlier, superseded fix) never ran on this post — absorb it
		// too rather than leaving it orphaned.
		const before = result.slice(0, spanStart);
		const dangling = before.match(/<!-- wp:image [^>]*-->\s*<figure\b[^>]*wp-block-gallery[^>]*>\s*$/);
		if (dangling) {
			spanStart -= dangling[0].length;
		}

		result = result.slice(0, spanStart) + frBlock + result.slice(spanEnd);
		changed = true;
	}

	return { result, changed };
}

/**
 * Rewrites links to other uneiaparjour.fr articles so they point at the EN
 * translation when one exists yet, per the fr_slug -> en_slug map built from
 * state.json. Falls back to leaving the original FR link untouched when no
 * EN translation exists yet (graceful degradation) — repairLinks() re-runs
 * this later once more of the backlog is translated.
 */
export function rewriteInternalLinks(html, slugMap) {
	return html.replace(
		/href="https?:\/\/(?:www\.)?uneiaparjour\.fr\/([a-z0-9-]+)\/?"/gi,
		(fullMatch, slug) => {
			const enSlug = slugMap.get(slug);
			if (!enSlug) {
				return fullMatch;
			}
			return `href="https://www.uneiaparjour.fr/en/${enSlug}/"`;
		}
	);
}
