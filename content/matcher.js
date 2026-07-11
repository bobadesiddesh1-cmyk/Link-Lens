/**
 * Link Lens — content/matcher.js
 * Main-content extraction + opportunity matching. Pure w.r.t. the DOM: it
 * only READS the document, so the same code runs on the live page and on
 * DOMParser documents in bulk mode.
 *
 * Performance: targets are precompiled into an inverted index keyed by
 * first token, so a 2,000-target × 5,000-word page is a single O(words)
 * sweep with tiny candidate lists per position.
 */
(function (ns) {
  'use strict';
  if (ns.matcher) return; // idempotent re-injection guard

  var tok = ns.tokenizer;

  var MAX_SUGGESTIONS = 30;
  var LOOSE_WINDOW = 10; // words
  var SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG',
    'NAV', 'FOOTER', 'ASIDE', 'FORM', 'IFRAME', 'BUTTON', 'SELECT', 'CODE', 'PRE']);
  var WORD_RE = /[\p{L}\p{N}]+/gu;

  /* ------------------------------------------------------------------ *
   * Content root selection
   * ------------------------------------------------------------------ */

  function textLength(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').length;
  }

  /**
   * Pick the main content element: <article> / <main> / [role=main],
   * else descend from <body> into whichever child holds the dominant
   * share of the text until no single child dominates ("largest text
   * block").
   */
  function findContentRoot(doc) {
    var candidates = ['article', 'main', '[role="main"]'];
    for (var i = 0; i < candidates.length; i++) {
      var els = doc.querySelectorAll(candidates[i]);
      var best = null, bestLen = 0;
      for (var j = 0; j < els.length; j++) {
        var len = textLength(els[j]);
        if (len > bestLen) { bestLen = len; best = els[j]; }
      }
      if (best && bestLen > 200) return best;
    }
    // Largest-text-block descent.
    var node = doc.body || doc.documentElement;
    if (!node) return doc.documentElement;
    for (var depth = 0; depth < 12; depth++) {
      var total = textLength(node);
      if (total === 0) break;
      var dominant = null;
      for (var c = node.firstElementChild; c; c = c.nextElementSibling) {
        if (SKIP_TAGS.has(c.tagName)) continue;
        if (textLength(c) > total * 0.7) { dominant = c; break; }
      }
      if (!dominant) break;
      node = dominant;
    }
    return node;
  }

  /* ------------------------------------------------------------------ *
   * Word-stream extraction
   * ------------------------------------------------------------------ */

  function hasAncestor(el, predicate, stopAt) {
    for (var n = el; n && n !== stopAt && n.nodeType === 1; n = n.parentElement) {
      if (predicate(n)) return true;
    }
    return false;
  }

  /**
   * Walk text nodes under the content root and emit the word stream:
   *   [{ w, node, start, end, inHeading, inLink }]
   * - w:      lowercase token
   * - node:   the Text node (live DOM or DOMParser node)
   * - start/end: character offsets of the word inside node.data
   * - inHeading: token sits inside h1–h6
   * - inLink: token sits inside an existing <a> (never matched, but kept
   *   in the stream so word-window distances stay honest)
   */
  function extractWords(root, doc) {
    var words = [];
    var walker = (doc || root.ownerDocument).createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (textNode) {
          var p = textNode.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (hasAncestor(p, function (el) {
            return SKIP_TAGS.has(el.tagName) ||
              el.getAttribute('aria-hidden') === 'true' ||
              el.hasAttribute('hidden') ||
              el.hasAttribute('data-link-lens'); // never re-match our own UI
          }, root.parentElement)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    var textNode;
    while ((textNode = walker.nextNode())) {
      var data = textNode.data;
      if (!data || !data.trim()) continue;
      var p = textNode.parentElement;
      var inLink = hasAncestor(p, function (el) { return el.tagName === 'A'; }, root.parentElement);
      var inHeading = hasAncestor(p, function (el) { return /^H[1-6]$/.test(el.tagName); }, root.parentElement);
      WORD_RE.lastIndex = 0;
      var m;
      while ((m = WORD_RE.exec(data))) {
        words.push({
          w: m[0].toLowerCase(),
          node: textNode,
          start: m.index,
          end: m.index + m[0].length,
          inHeading: inHeading,
          inLink: inLink
        });
      }
    }
    return words;
  }

  /** Every URL the page links to anywhere (normalized), for "already linked". */
  function collectPageLinks(doc, baseUrl) {
    var set = new Set();
    var anchors = doc.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var norm = tok.normalizeUrl(anchors[i].getAttribute('href'), baseUrl);
      if (norm) set.add(norm);
    }
    return set;
  }

  /** Normalized identities of the current page: its URL + its canonical. */
  function currentPageIdentities(doc, pageUrl) {
    var ids = new Set();
    var self = tok.normalizeUrl(pageUrl);
    if (self) ids.add(self);
    var canon = doc.querySelector('link[rel="canonical"]');
    if (canon) {
      var c = tok.normalizeUrl(canon.getAttribute('href'), pageUrl);
      if (c) ids.add(c);
    }
    return ids;
  }

  /* ------------------------------------------------------------------ *
   * Matching
   * ------------------------------------------------------------------ */

  /** Inverted index: first token → [targets]. Precompiled once per scan. */
  function buildInvertedIndex(targets) {
    var map = new Map();
    for (var i = 0; i < targets.length; i++) {
      var first = targets[i].tokens[0];
      var list = map.get(first);
      if (!list) { list = []; map.set(first, list); }
      list.push(targets[i]);
    }
    return map;
  }

  /**
   * Exact match test at position i: target tokens appear consecutively,
   * all inside the SAME text node, none inside a link.
   * Returns the end word index or -1.
   */
  function exactAt(words, i, tokens) {
    var node = words[i].node;
    for (var k = 0; k < tokens.length; k++) {
      var word = words[i + k];
      if (!word || word.w !== tokens[k]) return -1;
      if (word.node !== node || word.inLink) return -1;
    }
    return i + tokens.length - 1;
  }

  /**
   * Loose match test at position i: all target tokens appear (any order)
   * within a LOOSE_WINDOW-word window starting at i, same text node, no
   * link words. words[i] must be one of the tokens (it's the inverted-
   * index hit). Returns { end } = index of the last needed token, or null.
   */
  function looseAt(words, i, tokens) {
    var need = new Set(tokens);
    var node = words[i].node;
    var lastHit = -1;
    var limit = Math.min(words.length, i + LOOSE_WINDOW);
    for (var j = i; j < limit; j++) {
      var word = words[j];
      if (word.node !== node || word.inLink) break; // window must stay clean
      if (need.has(word.w)) {
        need.delete(word.w);
        lastHit = j;
        if (need.size === 0) return { end: lastHit };
      }
    }
    return null;
  }

  /** Slice the original text of one node between two word entries. */
  function sliceAnchor(words, startIdx, endIdx) {
    var node = words[startIdx].node;
    return node.data.slice(words[startIdx].start, words[endIdx].end);
  }

  /**
   * Extract the sentence around a match from its text node (trimmed to
   * ~300 chars when the "sentence" is a wall of text).
   */
  function contextSentence(words, startIdx, endIdx) {
    var node = words[startIdx].node;
    var text = node.data;
    var from = words[startIdx].start;
    var to = words[endIdx].end;
    // scan back to sentence start
    var s = 0;
    for (var i = from - 1; i > 0; i--) {
      if (/[.!?]/.test(text[i]) && /\s/.test(text[i + 1] || ' ')) { s = i + 1; break; }
    }
    // scan forward to sentence end
    var e = text.length;
    for (var j = to; j < text.length - 1; j++) {
      if (/[.!?]/.test(text[j]) && /\s/.test(text[j + 1] || ' ')) { e = j + 1; break; }
    }
    var sentence = text.slice(s, e).replace(/\s+/g, ' ').trim();
    if (sentence.length > 300) {
      var mid = Math.max(0, from - s - 120);
      sentence = (mid > 0 ? '…' : '') + sentence.slice(mid, mid + 280).trim() + '…';
    }
    return sentence;
  }

  /**
   * Decide whether candidate match `b` beats current best `a` for one
   * target: exact > loose; within a type, body > heading; then earliest.
   */
  function better(a, b) {
    if (!a) return true;
    if (a.matchType !== b.matchType) return b.matchType === 'exact';
    if (a.inHeading !== b.inHeading) return !b.inHeading;
    return b.startIdx < a.startIdx;
  }

  /**
   * The full matching pass.
   *
   * @param {Object} opts
   *   doc      — Document (live or DOMParser)
   *   pageUrl  — canonical string URL of the page being scanned
   *   targets  — index targets [{url, normUrl, phrase, tokens, depth}]
   * @returns {Object} {
   *   suggestions: [{ url, phrase, anchorText, matchType, inHeading, depth,
   *                   contextSentence, startIdx, endIdx, words }],
   *   alreadyLinked: [{url, phrase}],
   *   capped: bool, wordCount: int
   * }
   * `words` (the stream) is returned so the highlighter can reuse node refs.
   */
  function match(opts) {
    var doc = opts.doc;
    var pageUrl = opts.pageUrl;
    var selfIds = currentPageIdentities(doc, pageUrl);
    var pageLinks = collectPageLinks(doc, pageUrl);

    var active = [];
    var alreadyLinked = [];
    for (var i = 0; i < opts.targets.length; i++) {
      var t = opts.targets[i];
      if (selfIds.has(t.normUrl)) continue; // never suggest linking to self
      if (pageLinks.has(t.normUrl)) {
        alreadyLinked.push({ url: t.url, phrase: t.phrase });
        continue;
      }
      active.push(t);
    }

    var root = findContentRoot(doc);
    var words = extractWords(root, doc);
    var inverted = buildInvertedIndex(active);

    var bestByTarget = new Map(); // normUrl → best match record

    for (var pos = 0; pos < words.length; pos++) {
      var word = words[pos];
      if (word.inLink) continue; // never suggest inside an existing link
      var candidates = inverted.get(word.w);
      if (!candidates) continue;

      for (var c = 0; c < candidates.length; c++) {
        var target = candidates[c];
        var current = bestByTarget.get(target.normUrl);
        // Nothing can beat an exact body match — skip finished targets.
        if (current && current.matchType === 'exact' && !current.inHeading) continue;

        var rec = null;
        var exactEnd = exactAt(words, pos, target.tokens);
        if (exactEnd >= 0) {
          rec = { matchType: 'exact', startIdx: pos, endIdx: exactEnd };
        } else if (target.tokens.length > 1) {
          var loose = looseAt(words, pos, target.tokens);
          if (loose) rec = { matchType: 'loose', startIdx: pos, endIdx: loose.end };
        }
        if (!rec) continue;
        rec.inHeading = word.inHeading;
        rec.target = target;
        if (better(current, rec)) bestByTarget.set(target.normUrl, rec);
      }
    }

    // Rank: exact > loose, then shallower depth, then position. Cap at 30.
    var all = Array.from(bestByTarget.values());
    all.sort(function (a, b) {
      if (a.matchType !== b.matchType) return a.matchType === 'exact' ? -1 : 1;
      if (a.target.depth !== b.target.depth) return a.target.depth - b.target.depth;
      return a.startIdx - b.startIdx;
    });
    var capped = all.length > MAX_SUGGESTIONS;
    all = all.slice(0, MAX_SUGGESTIONS);

    var suggestions = all.map(function (rec) {
      return {
        url: rec.target.url,
        phrase: rec.target.phrase,
        depth: rec.target.depth,
        matchType: rec.matchType,
        inHeading: rec.inHeading,
        anchorText: sliceAnchor(words, rec.startIdx, rec.endIdx),
        contextSentence: contextSentence(words, rec.startIdx, rec.endIdx),
        startIdx: rec.startIdx,
        endIdx: rec.endIdx
      };
    });

    return {
      suggestions: suggestions,
      alreadyLinked: alreadyLinked,
      capped: capped,
      wordCount: words.length,
      words: words
    };
  }

  ns.matcher = {
    MAX_SUGGESTIONS: MAX_SUGGESTIONS,
    LOOSE_WINDOW: LOOSE_WINDOW,
    findContentRoot: findContentRoot,
    extractWords: extractWords,
    collectPageLinks: collectPageLinks,
    match: match
  };
})(self.__linkLens = self.__linkLens || {});
