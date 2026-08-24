import fs from 'fs';
import * as wp from './lib/wp.js';

/**
 * One-off read-only diagnostic (2026-08-24): the user found several EN
 * draft posts in wp-admin (Is it Fake?, PDF to Lesson, MAI Playground,
 * Overline, ...) showing raw French category names, and dates that don't
 * appear in the block editor's sidebar even though they show correctly in
 * the wp-admin posts list. None of these are tracked in
 * state/translations.json, so they were never caught by the earlier
 * per-state-entry category audit (debug-post-categories.js) that only
 * checked the 73 known-translated posts.
 *
 * This lists every draft post on the site, flags any whose id isn't in
 * state/translations.json (orphans), and for each orphan prints its real
 * author, raw date/date_gmt, and real per-category Polylang language (via
 * the same /term-audit ground truth used elsewhere) to find the true scope
 * and confirm/rule out the known "categories set before language" bug.
 *
 * Read-only. Makes no writes.
 *
 * Run: node debug-orphan-drafts.js
 */

const WP_URL = process.env.WP_URL.replace(/\/$/, '');
const AUTH_HEADER = 'Basic ' + Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString('base64');

async function fetchDraftsWithAuthor() {
	const posts = [];
	let page = 1;
	const perPage = 100;
	while (true) {
		const res = await fetch(
			`${WP_URL}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&status=draft&_fields=id,slug,title,date,date_gmt,author,categories,tags`,
			{ headers: { Authorization: AUTH_HEADER } }
		);
		if (!res.ok) {
			if (res.status === 400 && page > 1) break;
			const body = await res.text().catch(() => '');
			throw new Error(`WP REST GET /wp/v2/posts?status=draft (page ${page}) -> ${res.status}: ${body.slice(0, 500)}`);
		}
		const batch = await res.json();
		if (!Array.isArray(batch) || batch.length === 0) break;
		posts.push(...batch);
		if (batch.length < perPage) break;
		page += 1;
	}
	return posts;
}

async function main() {
	const me = await (await fetch(`${WP_URL}/wp-json/wp/v2/users/me`, { headers: { Authorization: AUTH_HEADER } })).json();
	console.log(`Authenticated as user #${me.id} (${me.name})`);

	const state = JSON.parse(fs.readFileSync(new URL('./state/translations.json', import.meta.url)));
	const knownEnIds = new Set(Object.values(state).map((s) => s.en_id).filter(Boolean));

	const [drafts, categoryRows, tagRows] = await Promise.all([
		fetchDraftsWithAuthor(),
		wp.termAudit('category'),
		wp.termAudit('post_tag'),
	]);
	const termById = new Map();
	for (const row of [...categoryRows, ...tagRows]) {
		termById.set(row.term_id, { name: row.name, lang: row.lang });
	}

	console.log(`\n${drafts.length} draft post(s) total on the site.`);

	const orphans = drafts.filter((p) => !knownEnIds.has(p.id));
	console.log(`${orphans.length} draft(s) NOT present in state/translations.json (orphans):\n`);

	for (const post of orphans) {
		const title = post.title?.rendered || post.title || '(sans titre)';
		console.log(`EN? #${post.id} "${title}" (slug: ${post.slug}, author: #${post.author})`);
		console.log(`  date: ${post.date}   date_gmt: ${post.date_gmt}`);

		console.log('  Categories:');
		if (!post.categories || post.categories.length === 0) {
			console.log('    (aucune)');
		}
		for (const catId of post.categories || []) {
			const term = termById.get(catId);
			if (!term) {
				console.log(`    #${catId} -> INTROUVABLE (terme supprimé ou id invalide)`);
			} else {
				const flag = term.lang === 'en' ? '' : '  <-- PROBLEME: pas en anglais';
				console.log(`    #${catId} "${term.name}" (lang=${term.lang ?? '(vide)'})${flag}`);
			}
		}

		console.log('  Tags:');
		if (!post.tags || post.tags.length === 0) {
			console.log('    (aucun)');
		}
		for (const tagId of post.tags || []) {
			const term = termById.get(tagId);
			if (!term) {
				console.log(`    #${tagId} -> INTROUVABLE (terme supprimé ou id invalide)`);
			} else {
				const flag = term.lang === 'en' ? '' : '  <-- PROBLEME: pas en anglais';
				console.log(`    #${tagId} "${term.name}" (lang=${term.lang ?? '(vide)'})${flag}`);
			}
		}
		console.log('');
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
