import * as wp from './lib/wp.js';

/**
 * One-off read-only(ish) diagnostic (2026-08-19): calls createOrGetTerm
 * directly for a known FR category (id + name given on the command line) to
 * see exactly what term_id and created/reused status the PHP endpoint
 * returns right now, live — bypassing taxonomy-map.json entirely. Every
 * newly-created EN post tonight ended up with its FR category ids assigned
 * directly instead of EN ones; this narrows down whether the bug is in the
 * PHP endpoint's resolution logic or somewhere in the JS pipeline around it.
 *
 * Not fully read-only: if the target EN term doesn't already exist, this
 * WILL create it (same as normal operation) — but for the categories in
 * question here, the EN term already exists, so this is expected to hit the
 * reuse path, not the creation path.
 *
 * Run: node debug-resolve-term.js <fr_term_id> <en_name>
 */
const [, , frIdArg, enName] = process.argv;
if (!frIdArg || !enName) {
	console.error('Usage: node debug-resolve-term.js <fr_term_id> <en_name>');
	process.exit(1);
}

async function main() {
	const result = await wp.createOrGetTerm('category', enName, parseInt(frIdArg, 10));
	console.log('Raw result from /create-term:', JSON.stringify(result, null, 2));
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
