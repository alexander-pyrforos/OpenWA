/**
 * Snippet highlight helpers. ORDER MATTERS: always `escapeHtml` BEFORE injecting `<mark>` via
 * `highlightQueryTerm`. `highlightMatchLine` enforces this for the raw-body case; for a Meilisearch
 * `_formatted.body` line (already escaped + already carrying `<mark>`), pass `alreadyFormatted: true`
 * so it is returned untouched. Breaking this invariant is an XSS.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wrap occurrences of `query` (case-insensitive, literal — not regex) in <mark> within an already-escaped string. */
export function highlightQueryTerm(escaped: string, query: string): string {
  const q = query.trim();
  if (!q) return escaped;
  const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
}

/**
 * Produce a safe, highlighted HTML string for one snippet line.
 * - `alreadyFormatted: true`  -> the line came from Meilisearch `_formatted.body` (already escaped +
 *   already carries `<mark>`); return it untouched.
 * - `alreadyFormatted: false` -> the line is raw message body; escape it, then highlight the query.
 *
 * ORDER MATTERS: escape first, then highlight. Reversing this lets raw markup from the body or the
 * query break out of the snippet as a live tag (XSS).
 */
export function highlightMatchLine(
  line: string,
  query: string,
  opts: { alreadyFormatted: boolean },
): string {
  if (opts.alreadyFormatted) return line;
  return highlightQueryTerm(escapeHtml(line), query);
}