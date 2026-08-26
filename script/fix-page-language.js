/**
 * One-off migration (2026-08-25): the original "everything was tagged en"
 * Polylang misconfiguration (see fix-language.js, 2026-08-17) was only ever
 * corrected for post_type=post (1319/1319 fixed). The site's static Pages
 * (À propos, Contact, Aide au choix, Base du site, Sélection, Écho,
 * Lectures, Lettre, Mentions et confidentialité, Plan du site) were
 * deliberately left out at the time as "out of scope" for the articles
 * project — but they never got fixed either, and still carry the original
 * wrong "en" tag despite being 100% French content. Found via Yoast's
 * auto-generated llms.txt listing French-titled pages under /en/ URLs.
 *
 * Same mechanism as fix-language.js (pll_set_post_language via the bridge
 * plugin's /set-language endpoint, works for any post type including
 * 'page'), just targeting pages instead of posts.
 *
 * Requires edit_others_posts (Editor+) — same promote/demote dance as
 * fix-language.js.
 *
 * --dry-run (default): list what would change, write nothing.
 * --apply: actually call /set-language for each page.
 *
 * Run: node fix-page-language.js [--apply]
 */
import * as wp from './lib/wp.js';

const APPLY = process.argv.includes('--apply');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WP_URL = process.env.WP_URL.replace(/\/$/, '');
const AUTH_HEADER = 'Basic ' + Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString('base64');

async function listAllPages() {
	const pages = [];
	let page = 1;
	const perPage = 100;
	while (true) {
		const res = await fetch(`${WP_URL}/wp-json/wp/v2/pages?per_page=${perPage}&page=${page}&status=publish&_fields=id,slug,title,link`, {
			headers: { Authorization: AUTH_HEADER },
		});
		if (!res.ok) {
			if (res.status === 400 && page > 1) break;
			const body = await res.text().catch(() => '');
			throw new Error(`WP REST GET /wp/v2/pages (page ${page}) -> ${res.status}: ${body.slice(0, 500)}`);
		}
		const batch = await res.json();
		if (!Array.isArray(batch) || batch.length === 0) break;
		pages.push(...batch);
		if (batch.length < perPage) break;
		page += 1;
	}
	return pages;
}

async function main() {
	console.log('Fetching all pages...');
	const pages = await listAllPages();
	console.log(`${pages.length} page(s) found.\n`);

	for (const p of pages) {
		const title = p.title?.rendered || '(untitled)';
		console.log(`#${p.id} "${title}" (/${p.slug}/) -> ${p.link}`);
	}

	if (!APPLY) {
		console.log('\nDRY RUN: nothing written. Re-run with --apply to set language=fr on all of these.');
		return;
	}

	console.log('\nSetting language to "fr" for all of them...');
	let ok = 0;
	const failures = [];
	for (const p of pages) {
		try {
			await wp.setLanguage(p.id, 'fr');
			ok += 1;
		} catch (err) {
			console.error(`Page #${p.id} (${p.slug}) failed: ${err.message}`);
			failures.push({ id: p.id, slug: p.slug, error: err.message });
		}
		await sleep(120);
	}
	console.log(`Done. ${ok} succeeded, ${failures.length} failed.`);
	if (failures.length > 0) {
		console.log('Failures:', JSON.stringify(failures, null, 2));
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exitCode = 1;
});
