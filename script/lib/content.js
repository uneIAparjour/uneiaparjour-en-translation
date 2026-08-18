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
 * Fixes wp:image blocks already written to already-translated EN posts,
 * before this file's own fixes existed (found live 2026-08-18 on Vunote):
 * a hardcoded lightbox:false that doesn't match the actual embedded markup
 * (WordPress's block validator flags this as "contenu invalide"), and WP
 * Gallery blocks whose outer <figure> was left unclosed by the old
 * non-greedy splitBlocks(). Pure string transform, no network access, so it
 * can (and should) be tested against a real captured sample before ever
 * running against the live site — the source of the two prior taxonomy
 * incidents this project has already had was skipping exactly that step.
 */
const WP_IMAGE_BLOCK_PATTERN = /<!-- wp:image [^>]*-->\n?([\s\S]*?)\n?<!-- \/wp:image -->/g;

export function repairImageBlockMarkup(rawContent) {
	let changed = false;
	const result = rawContent.replace(WP_IMAGE_BLOCK_PATTERN, (match, inner) => {
		let fixedInner = inner;
		const opens = (inner.match(/<figure\b/gi) || []).length;
		const closes = (inner.match(/<\/figure>/gi) || []).length;
		if (opens > closes) {
			// Dangling unclosed outer gallery <figure> — strip just that
			// leading orphaned opening tag, keep the inner (already
			// complete) child figure untouched. No content is lost: the old
			// splitBlocks() never dropped bytes, it only mis-split them.
			fixedInner = inner.replace(/^<figure\b[^>]*>\s*/i, '');
		}
		const lightboxEnabled = /data-wp-interactive="core\/image"|class="lightbox-trigger"/i.test(fixedInner);
		const newBlock = `<!-- wp:image {"lightbox":{"enabled":${lightboxEnabled}}} -->\n${fixedInner}\n<!-- /wp:image -->`;
		if (newBlock !== match) {
			changed = true;
		}
		return newBlock;
	});
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
