import * as wp from './lib/wp.js';
import { loadState } from './lib/state.js';
import { loadAllowedSlugs } from './lib/toolsDataset.js';

/**
 * Read-only status report: cross-references the 1275-tool dataset against
 * the live WP posts and the pipeline's own state, so gaps are visible
 * without manually comparing 1275 rows by hand. Never writes anything.
 *
 * Also verifies FR/EN publish dates match for every translated pair — the
 * pipeline sets EN's date once, from FR, at creation, and never touches it
 * again (see translate.js's isNewPost date-copy logic and the phase-04
 * incident where Polylang's own date-sync setting corrupted FR dates,
 * since disabled). A mismatch here means either a manual edit on the EN
 * side, or a regression of that class of bug — worth surfacing, not
 * guessing at (found live 2026-08-19: user suspected some EN dates/articles
 * were off after the busy review session, asked for a full FR/EN check).
 *
 * Run: node report.js
 */
async function main() {
	console.log('Fetching dataset, WP posts, and state...');
	const [allowedSlugs, allPosts, state] = await Promise.all([loadAllowedSlugs(), wp.listAllPosts(), loadState()]);

	const knownEnIds = new Set(Object.values(state).map((s) => s.en_id).filter(Boolean));
	// Same "what counts as an FR source post" logic as translate.js: any WP
	// post in the tools dataset that isn't itself a known EN translation.
	const frPostsBySlug = new Map();
	for (const post of allPosts) {
		if (knownEnIds.has(post.id)) continue;
		if (!allowedSlugs.has(post.slug)) continue;
		frPostsBySlug.set(post.slug, post);
	}

	const translated = [];
	const failed = [];
	const lockedSkip = [];
	const neverAttempted = [];
	const missingFromWp = [];

	for (const slug of allowedSlugs) {
		const post = frPostsBySlug.get(slug);
		if (!post) {
			// In the dataset but no matching FR post found in WP under this
			// slug — either the slug changed on the FR side since the dataset
			// snapshot, or the post was deleted/unpublished.
			missingFromWp.push(slug);
			continue;
		}
		const entry = state[post.id];
		if (!entry) {
			neverAttempted.push({ slug, id: post.id });
		} else if (entry.status === 'translated') {
			translated.push({ slug, id: post.id, frDate: post.date, enId: entry.en_id });
		} else if (entry.status === 'failed') {
			failed.push({ slug, id: post.id, error: entry.last_error });
		} else if (entry.status === 'locked_skip') {
			lockedSkip.push({ slug, id: post.id });
		} else {
			neverAttempted.push({ slug, id: post.id }); // unknown/unexpected status, treat as not done
		}
	}

	console.log('');
	console.log('=== Rapport de couverture ===');
	console.log(`Dataset (base officielle) : ${allowedSlugs.size} outils`);
	console.log(`  Traduits             : ${translated.length}`);
	console.log(`  Echoues              : ${failed.length}`);
	console.log(`  Verrouilles (manuel) : ${lockedSkip.length}`);
	console.log(`  Jamais traites       : ${neverAttempted.length}`);
	console.log(`  Introuvables sur WP  : ${missingFromWp.length}`);
	const total = translated.length + failed.length + lockedSkip.length + neverAttempted.length + missingFromWp.length;
	console.log(`  Total verifie        : ${total} / ${allowedSlugs.size}`);

	console.log('');
	console.log(`Verification des dates FR/EN sur ${translated.length} paire(s) traduite(s)...`);
	const dateMismatches = [];
	for (const t of translated) {
		try {
			const enPost = await wp.getPost(t.enId);
			if (enPost.date !== t.frDate) {
				dateMismatches.push({ ...t, enDate: enPost.date, enStatus: enPost.status });
			}
		} catch (err) {
			dateMismatches.push({ ...t, enDate: `ERREUR: ${err.message}`, enStatus: '?' });
		}
	}

	if (dateMismatches.length > 0) {
		console.log('');
		console.log(`--- ${dateMismatches.length} decalage(s) de date FR/EN (a verifier a la main) ---`);
		for (const d of dateMismatches) {
			console.log(`  FR #${d.id} /${d.slug}/ (statut EN: ${d.enStatus})`);
			console.log(`    FR : ${d.frDate}`);
			console.log(`    EN : ${d.enDate}  (EN #${d.enId})`);
		}
	} else {
		console.log('Aucun decalage de date detecte sur les paires traduites.');
	}

	if (failed.length > 0) {
		console.log('');
		console.log('--- Echoues (a corriger ou relancer) ---');
		for (const f of failed) {
			console.log(`  FR #${f.id} /${f.slug}/ : ${f.error}`);
		}
	}

	if (missingFromWp.length > 0) {
		console.log('');
		console.log('--- Introuvables sur WP (verifier a la main) ---');
		for (const slug of missingFromWp) {
			console.log(`  /${slug}/`);
		}
	}

	if (neverAttempted.length > 0 && neverAttempted.length <= 50) {
		console.log('');
		console.log('--- Jamais traites (seront pris au prochain run) ---');
		for (const n of neverAttempted) {
			console.log(`  FR #${n.id} /${n.slug}/`);
		}
	} else if (neverAttempted.length > 50) {
		console.log('');
		console.log(`--- ${neverAttempted.length} jamais traites (liste non affichee, trop longue) ---`);
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
