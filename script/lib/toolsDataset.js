const CSV_URL = 'https://huggingface.co/datasets/uneIAparjour/base/resolve/main/base-uneiaparjour.csv';

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
 * doubled "" escaped quotes, and embedded newlines inside quoted fields.
 * The dataset's Description column has all three, so a naive split(',')
 * or split('\n') would silently corrupt rows.
 */
function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = '';
	let inQuotes = false;

	for (let i = 0; i < text.length; i++) {
		const c = text[i];

		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += c;
			}
			continue;
		}

		if (c === '"') {
			inQuotes = true;
		} else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') {
				i++;
			}
			row.push(field);
			field = '';
			if (row.length > 1 || row[0] !== '') {
				rows.push(row);
			}
			row = [];
		} else {
			field += c;
		}
	}
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows;
}

/**
 * Only articles present in this dataset (the site's own curated "outils"
 * database, huggingface.co/datasets/uneIAparjour/base) get translated —
 * per the user's explicit scope decision, this excludes ~44 other posts
 * (newsletter/focus/lecture-type content) that share post_type=post but
 * aren't individual tool reviews.
 *
 * Fetched live on every run rather than committed as a static file: the
 * dataset updates nightly (new tool added daily), and a stale local copy
 * would silently exclude new tools until someone remembered to refresh it.
 */
export async function loadAllowedSlugs() {
	const res = await fetch(CSV_URL);
	if (!res.ok) {
		throw new Error(`Failed to fetch tools dataset CSV: ${res.status}`);
	}
	const raw = await res.text();
	const rows = parseCsv(raw);
	const [header, ...dataRows] = rows;
	const urlCol = header.indexOf('URL sur uneiaparjour.fr');
	if (urlCol === -1) {
		throw new Error('CSV header "URL sur uneiaparjour.fr" not found — dataset format may have changed.');
	}

	const slugs = new Set();
	for (const r of dataRows) {
		const url = r[urlCol];
		if (!url) continue;
		const match = url.match(/uneiaparjour\.fr\/([a-z0-9-]+)\/?$/i);
		if (match) {
			slugs.add(match[1].toLowerCase());
		}
	}
	return slugs;
}
