import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, highlightQueryTerm, highlightMatchLine } from './search-highlight.ts';

test('escapeHtml escapes HTML special characters', () => {
  assert.equal(escapeHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  assert.equal(escapeHtml('"a"&b'), '&quot;a&quot;&amp;b');
});

test('highlightQueryTerm wraps the query term in <mark>, case-insensitive, regex-safe', () => {
  assert.equal(highlightQueryTerm(escapeHtml('Hello world'), 'world'), 'Hello <mark>world</mark>');
  // literal, not regex
  assert.equal(highlightQueryTerm(escapeHtml('a.b*c'), 'a.b*c'), '<mark>a.b*c</mark>');
});

test('highlightQueryTerm wraps multiple matches in separate <mark> tags', () => {
  assert.equal(
    highlightQueryTerm(escapeHtml('foo bar foo'), 'foo'),
    '<mark>foo</mark> bar <mark>foo</mark>',
  );
});

test('highlightQueryTerm leaves text unchanged when query does not match', () => {
  assert.equal(highlightQueryTerm(escapeHtml('hello world'), 'zzz'), 'hello world');
});

test('highlightQueryTerm matches case-insensitively', () => {
  assert.equal(
    highlightQueryTerm(escapeHtml('Hello WORLD'), 'world'),
    'Hello <mark>WORLD</mark>',
  );
});

test('highlightMatchLine NEVER allows raw markup from the query or body to break out (XSS guard)', () => {
  // A malicious body containing a tag must be escaped before <mark> is injected.
  const out = highlightMatchLine('<img src=x onerror=alert(1)>', 'x', { alreadyFormatted: false });
  assert.doesNotMatch(out, /<img/);
  assert.ok(out.includes('&lt;img'));
  // A query that itself contains tag syntax must be treated as literal text.
  const out2 = highlightMatchLine('plain text', '<script>', { alreadyFormatted: false });
  assert.doesNotMatch(out2, /<script>/);
});

test('highlightMatchLine escapes entities in text before highlighting when body contains HTML', () => {
  const out = highlightMatchLine('a < b & c > d', 'b', { alreadyFormatted: false });
  assert.ok(out.includes('&lt;'));
  assert.ok(out.includes('&gt;'));
  assert.ok(out.includes('&amp;'));
  assert.ok(out.includes('<mark>b</mark>'));
});

test('highlightMatchLine passes an already-formatted (Meilisearch) line through untouched', () => {
  const line = 'Hello <mark>world</mark>';
  assert.equal(
    highlightMatchLine(line, 'world', { alreadyFormatted: true }),
    line,
  );
});