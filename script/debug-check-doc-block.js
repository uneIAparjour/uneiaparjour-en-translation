import * as wp from './lib/wp.js';

/**
 * One-off read-only diagnostic (2026-08-19): verifies a post's raw_content
 * has its embedded <!doctype html>...</html> block intact as one
 * contiguous span, not shredded with WordPress block comments spliced
 * through the middle (see content.js splitBlocks' "doc" case).
 *
 * Run: node debug-check-doc-block.js <post_id>
 */
const postId = process.argv[2];
if (!postId) {
	console.error('Usage: node debug-check-doc-block.js <post_id>');
	process.exit(1);
}

async function main() {
	const post = await wp.getPost(parseInt(postId, 10));
	const raw = post.raw_content || '';
	console.log(`raw_content length: ${raw.length}`);
	console.log(`raw_content type: ${typeof post.raw_content}`);
	console.log('--- last 500 chars ---');
	console.log(raw.slice(-500));
	console.log('--- occurrences ---');
	console.log('doctype count:', (raw.match(/<!doctype html/gi) || []).length);
	console.log('</html> count:', (raw.match(/<\/html>/gi) || []).length);
	console.log('<html count:', (raw.match(/<html\b/gi) || []).length);

	const startIdx = raw.toLowerCase().indexOf('<!doctype html');
	if (startIdx === -1) {
		console.log('No <!doctype html> block found in this post.');
		return;
	}
	const endIdx = raw.toLowerCase().indexOf('</html>', startIdx);
	if (endIdx === -1) {
		console.log('Found <!doctype html> but no matching </html> -- likely still broken.');
		return;
	}
	const span = raw.slice(startIdx, endIdx + '</html>'.length);
	const hasWpCommentInside = /<!--\s*\/?wp:/i.test(span);
	console.log(`Doc block span length: ${span.length} chars`);
	console.log(`Contains WordPress block comments inside (should be false): ${hasWpCommentInside}`);
	if (hasWpCommentInside) {
		const firstBad = span.match(/<!--\s*\/?wp:[^>]*-->/i);
		console.log('First offending fragment:', firstBad ? firstBad[0] : '(none)');
	} else {
		console.log('OK: doc block is intact, no WordPress block comments spliced inside.');
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
