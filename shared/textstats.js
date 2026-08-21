/**
 * Link Lens — shared/textstats.js
 * Term extraction + TF-IDF math. Pure, no DOM, no chrome.* — runs in the
 * content script, the offscreen crawler, and the side panel alike.
 *
 * Terms are stemmed unigrams AND bigrams, so "keyword research" is a term
 * in its own right (that's what internal-link anchors actually look like).
 */
(function (ns) {
  'use strict';
  if (ns.textstats) return; // idempotent re-injection guard

  var tok = ns.tokenizer;

  // Words too generic to carry topical meaning even outside the stopword list.
  var WEAK = new Set([
    'read', 'more', 'click', 'here', 'know', 'view', 'learn', 'apply', 'now',
    'best', 'top', 'good', 'great', 'need', 'want', 'make', 'made', 'take',
    'time', 'year', 'day', 'week', 'month', 'people', 'thing', 'things',
    'way', 'ways', 'lot', 'bit', 'part', 'kind', 'sort', 'case', 'point'
  ]);

  function usable(w) {
    return w.length >= 3 && !/^[0-9]+$/.test(w) &&
      !tok.STOPWORDS.has(w) && !WEAK.has(w);
  }

  /**
   * Extract term counts from text: stemmed unigrams + adjacent bigrams.
   * Returns a Map term -> count.
   */
  function termCounts(text) {
    var raw = tok.tokenizeText(text);
    var stems = [];
    for (var i = 0; i < raw.length; i++) {
      stems.push(usable(raw[i]) ? tok.stem(raw[i]) : null);
    }
    var counts = new Map();
    function bump(t) { counts.set(t, (counts.get(t) || 0) + 1); }
    for (var j = 0; j < stems.length; j++) {
      if (!stems[j]) continue;
      bump(stems[j]);
      if (stems[j + 1]) bump(stems[j] + ' ' + stems[j + 1]);
    }
    return counts;
  }

  /** Top-N terms of a Map, as [[term, count], ...] sorted desc. */
  function topTerms(counts, n) {
    var arr = [];
    counts.forEach(function (v, k) { arr.push([k, v]); });
    arr.sort(function (a, b) {
      if (b[1] !== a[1]) return b[1] - a[1];
      // prefer bigrams on ties — they're more distinctive
      var ab = a[0].indexOf(' ') !== -1, bb = b[0].indexOf(' ') !== -1;
      if (ab !== bb) return bb ? 1 : -1;
      return a[0] < b[0] ? -1 : 1;
    });
    return arr.slice(0, n || 30);
  }

  /** Inverse document frequency, smoothed. */
  function idf(df, totalDocs) {
    return Math.log(1 + (totalDocs || 1) / (1 + (df || 0)));
  }

  /**
   * TF-IDF weighted vector for a page: Map term -> weight, L2-normalized
   * so cosine similarity is a plain dot product.
   */
  function vector(termPairs, dfMap, totalDocs) {
    var vec = new Map();
    var sum = 0;
    for (var i = 0; i < termPairs.length; i++) {
      var term = termPairs[i][0];
      var tf = 1 + Math.log(termPairs[i][1]);
      var w = tf * idf(dfMap[term], totalDocs);
      if (w <= 0) continue;
      vec.set(term, w);
      sum += w * w;
    }
    if (sum > 0) {
      var norm = Math.sqrt(sum);
      vec.forEach(function (v, k) { vec.set(k, v / norm); });
    }
    return vec;
  }

  /** Cosine similarity of two normalized vectors (0..1). */
  function cosine(a, b) {
    if (!a || !b || a.size === 0 || b.size === 0) return 0;
    var small = a.size < b.size ? a : b;
    var large = small === a ? b : a;
    var dot = 0;
    small.forEach(function (v, k) {
      var o = large.get(k);
      if (o) dot += v * o;
    });
    return dot;
  }

  /**
   * Turn a title/H1 into a usable match phrase: strip the site-name tail
   * ("… | HDFC Bank"), drop stopwords, keep up to 4 tokens.
   * Returns { tokens, stems } or null.
   */
  function headingPhrase(text) {
    if (!text) return null;
    var head = String(text).split(/\s[|–—:·]\s/)[0];
    var raw = tok.tokenizeText(head);
    var tokens = [];
    for (var i = 0; i < raw.length && tokens.length < 4; i++) {
      if (usable(raw[i])) tokens.push(raw[i]);
    }
    if (tokens.length < 2) return null; // single words are too generic
    return { tokens: tokens, stems: tokens.map(tok.stem) };
  }

  ns.textstats = {
    termCounts: termCounts,
    topTerms: topTerms,
    idf: idf,
    vector: vector,
    cosine: cosine,
    headingPhrase: headingPhrase,
    usable: usable
  };
})(self.__linkLens = self.__linkLens || {});
