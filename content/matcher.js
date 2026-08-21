/**
 * Link Lens — content/matcher.js  (v2 matching engine)
 * Main-content extraction + opportunity matching. Only READS the DOM, so
 * the same code runs on the live page and on DOMParser documents (bulk).
 *
 * v2 fixes the "zero matches on real sites" failure modes:
 *  - words and slug tokens are STEMMED ("researching keywords" matches
 *    "keyword-research")
 *  - the inverted index is keyed by EVERY target token, not just the first
 *  - phrases may cross inline element boundaries (keyword <em>research</em>)
 *    as long as they stay inside one block element
 *  - 3+ token slugs accept a PARTIAL match (all but one token in a window)
 *  - site identity is www/scheme tolerant (see tokenizer.siteKey)
 *
 * Match types, ranked: exact (consecutive stems) > loose (all tokens in a
 * 12-word window, any order) > partial (n-1 of n tokens, n >= 3).
 */
(function (ns) {
  'use strict';
  if (ns.matcher) return; // idempotent re-injection guard

  var tok = ns.tokenizer;

  var MAX_SUGGESTIONS = 30;
  var LOOSE_WINDOW = 12; // words
  var SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG',
    'NAV', 'FOOTER', 'ASIDE', 'FORM', 'IFRAME', 'BUTTON', 'SELECT', 'CODE', 'PRE',
    'HEAD', 'TITLE']);
  var BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TD', 'TH', 'SECTION', 'ARTICLE',
    'BLOCKQUOTE', 'FIGCAPTION', 'DD', 'DT', 'MAIN', 'HEADER', 'SUMMARY',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BODY']);
  var WORD_RE = /[\p{L}\p{N}]+/gu;

  /* ------------------------------------------------------------------ *
   * Content root selection
   * ------------------------------------------------------------------ */

  function textLength(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').length;
  }

  var SKIP_SELECTOR = 'script,style,noscript,template,svg,nav,footer,aside,' +
    'form,iframe,button,select,code,pre,head,title';

  /**
   * Text length EXCLUDING skip-tag subtrees (nav, footer, script, ...).
   * Plain textContent counts mega-menu link text, which on nav-heavy
   * sites dominates the page and steers root selection into the header —
   * whose text the extractor then (rightly) rejects, yielding 0 words.
   */
  function effectiveTextLength(el) {
    var total = textLength(el);
    var skips = el.querySelectorAll(SKIP_SELECTOR);
    for (var i = 0; i < skips.length; i++) {
      // subtract only top-level skip elements (avoid double-subtraction
      // for nav-inside-form etc.)
      var p = skips[i].parentElement;
      var nested = false;
      while (p && p !== el) {
        if (SKIP_TAGS.has(p.tagName)) { nested = true; break; }
        p = p.parentElement;
      }
      if (!nested) total -= textLength(skips[i]);
    }
    return Math.max(0, total);
  }

  /**
   * Pick the main content element: <article> / <main> / [role=main],
   * else descend from <body> into whichever child holds the dominant
   * share of the (effective) text until no single child dominates.
   */
  function findContentRoot(doc) {
    var candidates = ['article', 'main', '[role="main"]'];
    for (var i = 0; i < candidates.length; i++) {
      var els = doc.querySelectorAll(candidates[i]);
      var best = null, bestLen = 0;
      for (var j = 0; j < els.length; j++) {
        var len = effectiveTextLength(els[j]);
        if (len > bestLen) { bestLen = len; best = els[j]; }
      }
      if (best && bestLen > 200) return best;
    }
    var node = doc.body || doc.documentElement;
    if (!node) return doc.documentElement;
    for (var depth = 0; depth < 12; depth++) {
      var total = effectiveTextLength(node);
      if (total === 0) break;
      var dominant = null;
      for (var c = node.firstElementChild; c; c = c.nextElementSibling) {
        if (SKIP_TAGS.has(c.tagName)) continue;
        if (effectiveTextLength(c) > total * 0.7) { dominant = c; break; }
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

  function nearestBlock(el, stopAt) {
    for (var n = el; n && n !== stopAt && n.nodeType === 1; n = n.parentElement) {
      if (BLOCK_TAGS.has(n.tagName)) return n;
    }
    return el;
  }

  /**
   * Walk text nodes under the content root and emit the word stream:
   *   [{ w (stem), raw, node, start, end, block, inHeading, inLink }]
   * `block` is the nearest block-level ancestor — matches never cross it,
   * but they MAY cross inline elements (em/strong/span) inside it.
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
      var block = nearestBlock(p, root.parentElement);
      WORD_RE.lastIndex = 0;
      var m;
      while ((m = WORD_RE.exec(data))) {
        words.push({
          w: tok.stem(m[0].toLowerCase()),
          raw: m[0],
          node: textNode,
          start: m.index,
          end: m.index + m[0].length,
          block: block,
          inHeading: inHeading,
          inLink: inLink
        });
      }
    }
    return words;
  }

  /** Every URL the page links to anywhere (siteKey form), for "already linked". */
  function collectPageLinks(doc, baseUrl) {
    var set = new Set();
    var anchors = doc.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var key = tok.siteKey(anchors[i].getAttribute('href'), baseUrl);
      if (key) set.add(key);
    }
    return set;
  }

  /** siteKey identities of the current page: its URL + its canonical. */
  function currentPageIdentities(doc, pageUrl) {
    var ids = new Set();
    var own = tok.siteKey(pageUrl);
    if (own) ids.add(own);
    var canon = doc.querySelector('link[rel="canonical"]');
    if (canon) {
      var c = tok.siteKey(canon.getAttribute('href'), pageUrl);
      if (c) ids.add(c);
    }
    return ids;
  }

  /* ------------------------------------------------------------------ *
   * Matching
   * ------------------------------------------------------------------ */

  /**
   * Inverted index over EVERY phrase of every target (slug phrase, plus
   * title/H1 and distinctive topic phrases once the site has been
   * crawled): stem → [{target, phrase}].
   */
  function buildInvertedIndex(targets) {
    var map = new Map();
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var phrases = t.phrases;
      if (!phrases) {
        // No intelligence layer yet: the slug phrase is all we know.
        t.stems = t.stems || (t.tokens || []).map(tok.stem);
        phrases = t.phrases = (t.tokens && t.tokens.length)
          ? [{ tokens: t.tokens, stems: t.stems, kind: 'slug', weight: 1 }]
          : [];
      }
      if (phrases.length === 0) continue; // nothing to match on (yet)
      for (var p = 0; p < phrases.length; p++) {
        var stems = phrases[p].stems;
        var added = new Set();
        for (var k = 0; k < stems.length; k++) {
          if (added.has(stems[k])) continue;
          added.add(stems[k]);
          var list = map.get(stems[k]);
          if (!list) { list = []; map.set(stems[k], list); }
          list.push({ target: t, phrase: phrases[p] });
        }
      }
    }
    return map;
  }

  /**
   * Exact match test at position i: target stems appear consecutively,
   * same block, none inside a link (inline tags are fine).
   * Returns the end word index or -1.
   */
  function exactAt(words, i, stems) {
    var block = words[i].block;
    for (var k = 0; k < stems.length; k++) {
      var word = words[i + k];
      if (!word || word.w !== stems[k]) return -1;
      if (word.block !== block || word.inLink) return -1;
    }
    return i + stems.length - 1;
  }

  /**
   * Windowed match at position i: how many distinct target stems appear
   * within LOOSE_WINDOW words (same block, link words don't count as
   * matches). Returns { hits, first, last } for the matched tokens.
   */
  function windowAt(words, i, stems) {
    var need = new Set(stems);
    var block = words[i].block;
    var first = -1, last = -1;
    var limit = Math.min(words.length, i + LOOSE_WINDOW);
    for (var j = i; j < limit; j++) {
      var word = words[j];
      if (word.block !== block) break; // never cross a block boundary
      if (word.inLink) continue;       // can't anchor inside an existing link
      if (need.has(word.w)) {
        need.delete(word.w);
        if (first === -1) first = j;
        last = j;
        if (need.size === 0) break;
      }
    }
    return {
      hits: stems.length - need.size,
      first: first,
      last: last,
      headHit: !need.has(stems[0]) // slug's head keyword was matched
    };
  }

  /**
   * Anchor text for words[s..e]: exact original text within one node,
   * node-segments joined with spaces when the phrase crosses inline tags.
   * Link words are excluded (they are never part of the anchor).
   */
  function sliceAnchor(words, s, e) {
    var parts = [];
    var curNode = null, from = 0, to = 0;
    for (var i = s; i <= e; i++) {
      var word = words[i];
      if (word.inLink) continue;
      if (word.node === curNode) {
        to = word.end;
      } else {
        if (curNode) parts.push(curNode.data.slice(from, to));
        curNode = word.node;
        from = word.start;
        to = word.end;
      }
    }
    if (curNode) parts.push(curNode.data.slice(from, to));
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  /** The sentence around a match, from its first word's text node. */
  function contextSentence(words, startIdx, endIdx) {
    var node = words[startIdx].node;
    var text = node.data;
    var from = words[startIdx].start;
    var to = Math.min(words[endIdx].node === node ? words[endIdx].end : text.length, text.length);
    var s = 0;
    for (var i = from - 1; i > 0; i--) {
      if (/[.!?]/.test(text[i]) && /\s/.test(text[i + 1] || ' ')) { s = i + 1; break; }
    }
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

  var TYPE_RANK = { exact: 3, loose: 2, partial: 1 };

  /**
   * Where a match sits in the copy. Links in the first ~100 words carry
   * the most weight; matches in the last third of a long page are noted
   * as deep.
   */
  function positionOf(startIdx, totalWords) {
    if (startIdx < 100) return 'early';
    if (totalWords > 300 && startIdx > totalWords * 0.7) return 'deep';
    return 'body';
  }

  /** Does candidate `b` beat current best `a` for one target? */
  function better(a, b) {
    if (!a) return true;
    if (TYPE_RANK[a.matchType] !== TYPE_RANK[b.matchType]) {
      return TYPE_RANK[b.matchType] > TYPE_RANK[a.matchType];
    }
    if (a.inHeading !== b.inHeading) return !b.inHeading; // body beats heading
    return b.startIdx < a.startIdx;
  }

  /**
   * The full matching pass.
   * opts: { doc, pageUrl, targets }
   * Returns { suggestions, alreadyLinked, capped, wordCount, words }.
   */
  function match(opts) {
    var doc = opts.doc;
    var pageUrl = opts.pageUrl;
    var selfIds = currentPageIdentities(doc, pageUrl);
    var pageLinks = collectPageLinks(doc, pageUrl);

    // Group targets by phrase: sitemaps routinely contain locale/duplicate
    // variants of the same page (/ai-platform, /zh-cn/ai-platform, ...).
    // One phrase = one suggestion (the shallowest/shortest URL), and if the
    // page already links ANY variant, the whole phrase counts as linked.
    var groups = new Map(); // phrase → { linkedUrl, rep }
    for (var i = 0; i < opts.targets.length; i++) {
      var t = opts.targets[i];
      var key = t.siteKey || tok.siteKey(t.url);
      t.siteKey = key;
      if (!key || selfIds.has(key)) continue; // never suggest linking to self
      var groupKey = t.phrase || t.siteKey;
      var g = groups.get(groupKey);
      if (!g) { g = { linkedUrl: null, rep: null }; groups.set(groupKey, g); }
      if (pageLinks.has(key)) {
        if (!g.linkedUrl) g.linkedUrl = t.url;
        continue;
      }
      if (!g.rep || t.depth < g.rep.depth ||
          (t.depth === g.rep.depth && t.url.length < g.rep.url.length)) {
        g.rep = t;
      }
    }

    var active = [];
    var alreadyLinked = [];
    groups.forEach(function (g, phrase) {
      if (g.linkedUrl) alreadyLinked.push({ url: g.linkedUrl, phrase: phrase || g.linkedUrl });
      else if (g.rep) active.push(g.rep);
    });

    var root = findContentRoot(doc);
    var words = extractWords(root, doc);
    // Safety net: if root selection landed on a subtree with no usable
    // text, fall back to the whole body (per-node skip rules still apply).
    if (words.length === 0 && doc.body && root !== doc.body) {
      root = doc.body;
      words = extractWords(root, doc);
    }
    var inverted = buildInvertedIndex(active);

    var bestByTarget = new Map(); // siteKey → best match record

    for (var pos = 0; pos < words.length; pos++) {
      var word = words[pos];
      if (word.inLink) continue;
      var candidates = inverted.get(word.w);
      if (!candidates) continue;

      for (var c = 0; c < candidates.length; c++) {
        var target = candidates[c].target;
        var phrase = candidates[c].phrase;
        var current = bestByTarget.get(target.siteKey);
        // Nothing beats an exact body match — skip finished targets.
        if (current && current.matchType === 'exact' && !current.inHeading) continue;

        var stems = phrase.stems;
        var n = stems.length;
        var rec = null;

        // Exact only makes sense anchored at the first token.
        if (word.w === stems[0]) {
          var exactEnd = exactAt(words, pos, stems);
          if (exactEnd >= 0) {
            rec = { matchType: 'exact', startIdx: pos, endIdx: exactEnd };
          }
        }
        if (!rec && n > 1) {
          var win = windowAt(words, pos, stems);
          if (win.hits === n) {
            rec = { matchType: 'loose', startIdx: win.first, endIdx: win.last };
          } else if (n >= 3 && win.hits >= n - 1 && win.hits >= 2 && win.headHit) {
            // Partial matches must include the slug's head keyword —
            // matching only the generic tail ("generally available") of
            // "ai-gateway-is-generally-available" is a false positive.
            rec = { matchType: 'partial', startIdx: win.first, endIdx: win.last };
          }
        }
        if (!rec) continue;
        rec.inHeading = words[rec.startIdx].inHeading;
        rec.target = target;
        rec.phraseKind = phrase.kind;
        rec.phraseWeight = phrase.weight;
        if (better(current, rec)) bestByTarget.set(target.siteKey, rec);
      }
    }

    var all = Array.from(bestByTarget.values());

    // With a crawl model available, rank by the 0-100 opportunity score
    // (match quality + topical relevance + how badly the target needs
    // links + placement). Without one, fall back to the structural rank.
    var model = opts.model || null;
    var pageVec = null, medianIn = 0;
    if (model && ns.textstats && ns.intel) {
      var pageText = [];
      for (var wi = 0; wi < words.length; wi++) pageText.push(words[wi].raw);
      var counts = ns.textstats.termCounts(pageText.join(' '));
      pageVec = ns.textstats.vector(ns.textstats.topTerms(counts, 40), model.df, model.totalDocs);
      medianIn = ns.intel.medianInbound(model, active);
    }

    all.forEach(function (rec) {
      if (!model || !ns.intel) { rec.score = null; rec.reasons = []; return; }
      var scored = ns.intel.score({
        suggestion: {
          matchType: rec.matchType,
          inHeading: rec.inHeading,
          position: positionOf(rec.startIdx, words.length),
          phraseKind: rec.phraseKind,
          anchorText: sliceAnchor(words, rec.startIdx, Math.min(rec.endIdx, rec.startIdx + 5))
        },
        target: rec.target,
        model: model,
        pageVec: pageVec,
        medianInbound: medianIn
      });
      rec.score = scored.score;
      rec.reasons = scored.reasons;
    });

    all.sort(function (a, b) {
      if (a.score !== null && b.score !== null && a.score !== b.score) return b.score - a.score;
      if (a.matchType !== b.matchType) return TYPE_RANK[b.matchType] - TYPE_RANK[a.matchType];
      var ta = (a.target.tokens || []).length, tb = (b.target.tokens || []).length;
      if (ta !== tb) return tb - ta;
      if (a.target.depth !== b.target.depth) return a.target.depth - b.target.depth;
      return a.startIdx - b.startIdx;
    });
    // One suggestion per text span: when several targets matched the same
    // words, keep only the best-ranked one (prevents "Zero Trust" x4 and
    // stacked highlights that can't all be wrapped).
    var taken = [];
    var deduped = [];
    for (var d = 0; d < all.length; d++) {
      var r = all[d];
      var overlaps = taken.some(function (range) {
        return r.startIdx <= range[1] && r.endIdx >= range[0];
      });
      if (overlaps) continue;
      taken.push([r.startIdx, r.endIdx]);
      deduped.push(r);
    }
    var capped = deduped.length > MAX_SUGGESTIONS;
    all = deduped.slice(0, MAX_SUGGESTIONS);

    var suggestions = all.map(function (rec) {
      // Trim sprawling loose/partial anchors to a natural span (≤6 words) —
      // editors need "Zero Trust platform", not a 10-word run-on.
      if (rec.matchType !== 'exact' && rec.endIdx - rec.startIdx > 5) {
        rec.endIdx = rec.startIdx + 5;
      }
      return {
        url: rec.target.url,
        phrase: rec.target.phrase,
        title: rec.target.title || null,
        depth: rec.target.depth,
        matchType: rec.matchType,
        phraseKind: rec.phraseKind || 'slug',
        score: rec.score,
        reasons: rec.reasons || [],
        inbound: rec.target.inbound,
        inHeading: rec.inHeading,
        position: positionOf(rec.startIdx, words.length),
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

  /**
   * Keyword mode: does THIS page mention the keyword (and not yet link
   * the target)? Used against DOMParser docs of other site pages.
   *
   * opts: { doc, pageUrl, stems (keyword stems), targetKey (siteKey) }
   * Returns { alreadyLinked } or { occurrences: [{anchorText,
   *   contextSentence, position, matchType}] } (max 3 per page).
   */
  function keywordScan(opts) {
    var links = collectPageLinks(opts.doc, opts.pageUrl);
    if (opts.targetKey && links.has(opts.targetKey)) return { alreadyLinked: true };

    var root = findContentRoot(opts.doc);
    var words = extractWords(root, opts.doc);
    if (words.length === 0 && opts.doc.body && root !== opts.doc.body) {
      words = extractWords(opts.doc.body, opts.doc);
    }
    var stems = opts.stems;
    var maxOcc = opts.maxOccurrences || 3;
    var occ = [];
    for (var pos = 0; pos < words.length && occ.length < maxOcc; pos++) {
      var word = words[pos];
      if (word.inLink || word.w !== stems[0]) continue;
      var rec = null;
      var exactEnd = exactAt(words, pos, stems);
      if (exactEnd >= 0) {
        rec = { matchType: 'exact', s: pos, e: exactEnd };
      } else if (stems.length > 1) {
        var win = windowAt(words, pos, stems);
        if (win.hits === stems.length) rec = { matchType: 'loose', s: win.first, e: win.last };
      }
      if (!rec) continue;
      if (rec.matchType !== 'exact' && rec.e - rec.s > 5) rec.e = rec.s + 5;
      occ.push({
        matchType: rec.matchType,
        // Relevance per SEO practice: exact keyword in copy = High,
        // all-words-nearby (semantic-ish) = Medium.
        relevance: rec.matchType === 'exact' ? 'High' : 'Medium',
        position: positionOf(rec.s, words.length),
        inHeading: words[rec.s].inHeading,
        anchorText: sliceAnchor(words, rec.s, rec.e),
        contextSentence: contextSentence(words, rec.s, rec.e),
        startIdx: rec.s,
        endIdx: rec.e
      });
      pos = rec.e; // don't re-match inside the same span
    }
    return {
      alreadyLinked: false,
      occurrences: occ,
      wordCount: words.length,
      words: opts.withWords ? words : undefined
    };
  }

  ns.matcher = {
    MAX_SUGGESTIONS: MAX_SUGGESTIONS,
    LOOSE_WINDOW: LOOSE_WINDOW,
    findContentRoot: findContentRoot,
    extractWords: extractWords,
    collectPageLinks: collectPageLinks,
    match: match,
    keywordScan: keywordScan
  };
})(self.__linkLens = self.__linkLens || {});
