import type { IDataObject } from 'n8n-workflow';

/**
 * Count how many email entries a list file holds, so an upload can report an
 * `item_count` even when the API does not return one.
 *
 * A first row containing no "@" is treated as a header and excluded; blank
 * lines never count.
 */
export function countListItems(content: string | Buffer): number {
	const rows = parseCsv(typeof content === 'string' ? content : content.toString('utf8')).filter(
		(row) => row.some((cell) => cell.trim() !== ''),
	);
	if (rows.length === 0) {
		return 0;
	}
	const hasHeader = !rows[0].some((cell) => cell.includes('@'));
	return hasHeader ? rows.length - 1 : rows.length;
}

/**
 * Read the file name a download was served under, from its
 * `Content-Disposition` header. Returns undefined when the header is absent or
 * carries no name, so the caller can fall back to one of its own.
 */
export function filenameFromHeaders(headers: IDataObject): string | undefined {
	const disposition = headers?.['content-disposition'];
	if (typeof disposition !== 'string') {
		return undefined;
	}

	// RFC 5987 form first (filename*=UTF-8''name.csv), then the plain form
	const encoded = /filename\*=(?:[^']*'[^']*')?([^;]+)/i.exec(disposition);
	if (encoded) {
		try {
			return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, '')) || undefined;
		} catch {
			// Fall through to the plain form
		}
	}

	const plain = /filename="?([^";]+)"?/i.exec(disposition);
	return plain ? plain[1].trim() || undefined : undefined;
}

/**
 * Translate a QuickEmailVerification job state into the capitalised
 * `file_status` label used by the node output.
 * Unknown states are passed through unchanged.
 */
export function toFileStatus(status: string | undefined): string {
	switch ((status ?? '').toLowerCase()) {
		case 'completed':
			return 'Complete';
		case 'running':
			return 'Processing';
		case 'ready':
			return 'Queued';
		case 'failed':
			return 'Failed';
		default:
			return status || 'Unknown';
	}
}

/**
 * Convert a CSV report into an array of JSON records keyed by the header row.
 * Values of "true"/"false" are converted to booleans; everything else stays a string.
 */
export function csvToJson(csv: string): IDataObject[] {
	const table = parseCsv(csv);
	if (table.length === 0) {
		return [];
	}

	const header = table[0].map((name, index) => name.trim() || `field_${index}`);
	const records: IDataObject[] = [];

	for (let row = 1; row < table.length; row++) {
		const cells = table[row];
		// Skip blank trailing lines
		if (cells.length === 1 && cells[0].trim() === '') {
			continue;
		}

		// Object.create(null) avoids prototype pollution from a hostile header (e.g. "__proto__").
		const record = Object.create(null) as IDataObject;
		header.forEach((key, column) => {
			record[key] = normaliseCell(cells[column] ?? '');
		});
		records.push(record);
	}

	return records;
}

/**
 * Remove duplicate email records, keeping the first occurrence.
 * Matching is case-insensitive on the `email` column (any casing of the header).
 * Records without a recognisable email are always kept.
 */
export function dedupeByEmail(records: IDataObject[]): IDataObject[] {
	const seen = new Set<string>();
	const result: IDataObject[] = [];

	for (const record of records) {
		const email = readEmail(record);
		if (!email) {
			result.push(record);
			continue;
		}
		const key = email.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(record);
	}

	return result;
}

/** Find the email value in a record regardless of header casing. */
function readEmail(record: IDataObject): string | undefined {
	for (const key of Object.keys(record)) {
		if (key.toLowerCase() === 'email') {
			const value = record[key];
			return typeof value === 'string' ? value.trim() : undefined;
		}
	}
	return undefined;
}

/** Coerce common boolean-looking cell values. */
function normaliseCell(value: string): string | boolean {
	const lowered = value.trim().toLowerCase();
	if (lowered === 'true') return true;
	if (lowered === 'false') return false;
	return value;
}

/**
 * RFC-4180-style CSV tokeniser. Handles quoted fields, escaped quotes (""),
 * embedded commas/newlines, and both LF and CRLF line endings.
 * Exported for unit testing.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let value = '';
	let quoted = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (quoted) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					value += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				value += char;
			}
			continue;
		}

		switch (char) {
			case '"':
				quoted = true;
				break;
			case ',':
				row.push(value);
				value = '';
				break;
			case '\n':
				row.push(value);
				rows.push(row);
				row = [];
				value = '';
				break;
			case '\r':
				// Ignore; CRLF is handled by the '\n' branch
				break;
			default:
				value += char;
		}
	}

	if (value !== '' || row.length > 0) {
		row.push(value);
		rows.push(row);
	}

	return rows;
}
