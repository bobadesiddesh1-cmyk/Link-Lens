/**
 * Link Lens — content/highlighter.js
 * Non-destructive inline highlighting with an exact-restore registry.
 *
 * Strategy: for each text node that contains ≥1 match, the ORIGINAL text
 * node is detached (kept intact in the registry) and replaced by a
 * sequence of plain text nodes + highlight <span>s. Clear() re-inserts
 * the original node and removes the replacements — the DOM is restored
 * byte-for-byte, including text-node boundaries.
 */
(function (ns) {
  'use strict';
  if (ns.highlighter) return; // idempotent re-injection guard

  var HIGHLIGHT_GREEN = '#22C55E';

  // registry: [{ parent, originalNode, insertedNodes: [Node] }]
  var registry = [];
  var spansById = new Map(); // suggestion id → span element
  var clickHandler = null;

  function makeSpan(doc, text, id) {
    var span = doc.createElement('span');
    span.setAttribute('data-link-lens', 'highlight');
    span.setAttribute('data-ll-id', String(id));
    span.textContent = text;
    span.style.cssText = [
      'background-color: rgba(34, 197, 94, 0.2)',   // #22C55E @ 20%
      'text-decoration: underline solid ' + HIGHLIGHT_GREEN + ' 2px',
      'text-underline-offset: 2px',
      'border-radius: 2px',
      'cursor: pointer',
      'transition: background-color .25s ease'
    ].join(';');
    span.title = 'Link Lens: click for link suggestion';
    span.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (clickHandler) clickHandler(id, span);
    }, true);
    return span;
  }

  /**
   * Apply highlights for suggestions produced by matcher.match().
   * Each suggestion gets an id (its array index). A match may cross
   * inline tags, so it is wrapped as one segment PER text node; all
   * segments share the suggestion id (the first is the primary span
   * used for focus/pulse). Link words never get wrapped.
   */
  function apply(suggestions, words, onClick) {
    clear(); // idempotent re-scan
    clickHandler = onClick || null;

    // Split each suggestion into per-text-node segments, then group by node.
    var byNode = new Map();
    suggestions.forEach(function (s, id) {
      var curNode = null, from = 0, to = 0, isFirst = true;
      function flush() {
        if (!curNode) return;
        var list = byNode.get(curNode);
        if (!list) { list = []; byNode.set(curNode, list); }
        list.push({ id: id, from: from, to: to, primary: isFirst });
        isFirst = false;
        curNode = null;
      }
      for (var i = s.startIdx; i <= s.endIdx; i++) {
        var word = words[i];
        if (word.inLink) continue;
        if (word.node === curNode) {
          to = word.end;
        } else {
          flush();
          curNode = word.node;
          from = word.start;
          to = word.end;
        }
      }
      flush();
    });

    byNode.forEach(function (matches, textNode) {
      var parent = textNode.parentNode;
      if (!parent || !textNode.isConnected) return;
      var doc = textNode.ownerDocument;
      var data = textNode.data;

      // Sort by position and drop overlaps (first wins) so slicing stays sane.
      matches.sort(function (a, b) { return a.from - b.from; });
      var kept = [];
      var lastEnd = -1;
      for (var i = 0; i < matches.length; i++) {
        if (matches[i].from >= lastEnd) {
          kept.push(matches[i]);
          lastEnd = matches[i].to;
        }
      }

      var inserted = [];
      var cursor = 0;
      kept.forEach(function (m) {
        if (m.from > cursor) inserted.push(doc.createTextNode(data.slice(cursor, m.from)));
        var span = makeSpan(doc, data.slice(m.from, m.to), m.id);
        // The primary (first) segment is the focus/pulse anchor.
        if (m.primary || !spansById.has(m.id)) spansById.set(m.id, span);
        inserted.push(span);
        cursor = m.to;
      });
      if (cursor < data.length) inserted.push(doc.createTextNode(data.slice(cursor)));

      var anchor = doc.createTextNode(''); // placeholder to keep position
      parent.replaceChild(anchor, textNode);
      inserted.forEach(function (n) { parent.insertBefore(n, anchor); });
      parent.removeChild(anchor);

      registry.push({
        parent: parent,
        originalNode: textNode,
        insertedNodes: inserted
      });
    });

    return spansById;
  }

  /** Restore the DOM exactly: original text nodes back, wrappers out. */
  function clear() {
    for (var i = registry.length - 1; i >= 0; i--) {
      var entry = registry[i];
      var first = entry.insertedNodes[0];
      if (first && first.parentNode === entry.parent) {
        entry.parent.insertBefore(entry.originalNode, first);
      }
      entry.insertedNodes.forEach(function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
    }
    registry = [];
    spansById = new Map();
    clickHandler = null;
  }

  /** Scroll a suggestion's highlight into view and pulse it. */
  function focusSuggestion(id) {
    var span = spansById.get(id);
    if (!span || !span.isConnected) return false;
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var pulses = 0;
    var on = false;
    var timer = setInterval(function () {
      on = !on;
      span.style.backgroundColor = on ? 'rgba(34, 197, 94, 0.55)' : 'rgba(34, 197, 94, 0.2)';
      if (++pulses >= 6) {
        clearInterval(timer);
        span.style.backgroundColor = 'rgba(34, 197, 94, 0.2)';
      }
    }, 250);
    return true;
  }

  function getSpan(id) { return spansById.get(id) || null; }

  function isActive() { return registry.length > 0; }

  ns.highlighter = {
    apply: apply,
    clear: clear,
    focusSuggestion: focusSuggestion,
    getSpan: getSpan,
    isActive: isActive
  };
})(self.__linkLens = self.__linkLens || {});
