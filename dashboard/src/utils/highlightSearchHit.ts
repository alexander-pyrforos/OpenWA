/**
 * Wrap the first occurrence of a search match in a rendered message body with a highlight mark element.
 * The body is rendered through MessageBody (parseMessageBody for bold/italic/strike/code formatting)
 * and Linkify (URL → anchor), so the character offsets in the raw body string don't map 1:1 to DOM
 * text-node positions. We instead search the flattened text content of a target root for the matched
 * substring and walk text nodes (NodeFilter.SHOW_TEXT) to locate the one that contains it.
 *
 * Returns the inserted mark element so the caller can scroll it into view and remove it later.
 * Returns null if the match isn't found in the rendered text (e.g. the body has been re-edited,
 * a plugin stripped formatting, or the substring is split across separate text nodes by an inline
 * formatter — in that case the caller falls back to the whole-message scroll + message-level
 * highlight).
 */
export function highlightSearchMatch(
  root: HTMLElement,
  matchText: string,
): HTMLElement | null {
  if (!matchText) return null;

  // TreeWalker over the message root's subtree. Skip text nodes inside <a>/<code>/<pre> only as a
  // courtesy: Linkify's <a> wraps a URL substring and parseMessageBody's <code>/<pre> blocks would
  // otherwise show a hit inside a quoted-code block that the user didn't actually type into the
  // chat. We still walk them on the final fallback path below if the match isn't found elsewhere.
  const directChildren = Array.from(root.querySelectorAll<HTMLElement>('p, div, span, strong, em, s, b, i'))
    .filter(el => !el.closest('a, code, pre'));
  const candidates: Element[] = directChildren.length > 0 ? directChildren : [root];

  for (const el of candidates) {
    const mark = tryWrapInNode(el, matchText);
    if (mark) return mark;
  }
  // Final fallback: walk the entire root without exclusions (in case the match really is inside a
  // code block or link). We don't recurse into <script>/<style>.
  const mark = tryWrapInNode(root, matchText, /* allowLinks */ true);
  return mark;
}

function tryWrapInNode(root: Element, matchText: string, allowLinks = false): HTMLElement | null {
  // Collect text nodes (and the start offset of each within the full flattened string) so we can
  // locate the one that contains the matched substring.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      if (!allowLinks) {
        const parent = node.parentElement;
        if (parent && parent.closest('a, code, pre')) return NodeFilter.FILTER_REJECT;
      }
      // Skip whitespace-only text nodes (between inline elements) to reduce false positives.
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  let fullText = '';
  let n: Node | null = walker.nextNode();
  while (n) {
    textNodes.push(n as Text);
    fullText += n.nodeValue;
    n = walker.nextNode();
  }

  const idx = fullText.indexOf(matchText);
  if (idx === -1) return null;

  // Walk again, this time locating the text node that contains `idx` and the offset within it.
  let acc = 0;
  for (const tn of textNodes) {
    const len = tn.nodeValue!.length;
    if (acc + len > idx) {
      const offsetInNode = idx - acc;
      // Split the text node: before, mark, after.
      const before = tn.nodeValue!.slice(0, offsetInNode);
      const match = tn.nodeValue!.slice(offsetInNode, offsetInNode + matchText.length);
      const after = tn.nodeValue!.slice(offsetInNode + matchText.length);

      const parent = tn.parentNode;
      if (!parent) return null;

      const markEl = document.createElement('mark');
      markEl.className = 'is-search-match';
      markEl.textContent = match;

      if (before) tn.nodeValue = before;
      else parent.removeChild(tn);
      parent.insertBefore(markEl, after ? null : tn.nextSibling);
      if (after) {
        const afterNode = document.createTextNode(after);
        parent.insertBefore(afterNode, markEl.nextSibling);
      }
      return markEl;
    }
    acc += len;
  }
  return null;
}

/** Remove any <mark class="is-search-match"> elements previously inserted by highlightSearchMatch.
 *  Restores the original text content in place. */
export function clearSearchHighlights(root: HTMLElement): void {
  const marks = Array.from(root.querySelectorAll<HTMLElement>('mark.is-search-match'));
  for (const m of marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    // Coalesce adjacent text nodes so the DOM tree stays clean.
    parent.normalize();
  }
}
