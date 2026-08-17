/**
 * Splits a flat sequence of top-level HTML block elements into an array of
 * { tag, html } entries. Matches this site's actual content shape (verified
 * empirically across ~20 real articles: simple flat paragraphs/lists/headings,
 * no nested Gutenberg blocks) — not a general-purpose HTML/Gutenberg parser.
 */
const BLOCK_PATTERN = /<(p|h[1-6]|ul|ol|blockquote|figure|table)\b[^>]*>[\s\S]*?<\/\1>/gi;

export function splitBlocks(html) {
	const blocks = [];
	let match;
	BLOCK_PATTERN.lastIndex = 0;
	while ((match = BLOCK_PATTERN.exec(html)) !== null) {
		blocks.push({ tag: match[1].toLowerCase(), html: match[0] });
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
			// Safe fallback for anything not explicitly mapped (figure, table...):
			// keep the markup working without claiming a block type we're not sure of.
			return `<!-- wp:html -->\n${html}\n<!-- /wp:html -->`;
		})
		.join('\n\n');
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
