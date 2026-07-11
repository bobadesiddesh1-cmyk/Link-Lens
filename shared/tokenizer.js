/**
 * Link Lens — shared/tokenizer.js
 * Pure slug/text tokenization. No DOM, no chrome.* — safe in any context.
 *
 * Exposed on the self.__linkLens namespace (classic script; MV3
 * executeScript file lists cannot use ES modules, see DECISIONS.md).
 */
(function (ns) {
  'use strict';
  if (ns.tokenizer) return; // idempotent re-injection guard

  // 70+ entries. Common English stopwords plus URL-slug noise words.
  var STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'yours', 'all',
    'any', 'can', 'had', 'has', 'have', 'her', 'his', 'him', 'how', 'its',
    'may', 'new', 'now', 'old', 'one', 'our', 'out', 'own', 'she', 'that',
    'them', 'they', 'this', 'these', 'those', 'was', 'were', 'what', 'when',
    'where', 'which', 'who', 'whom', 'why', 'will', 'with', 'without', 'from',
    'into', 'onto', 'over', 'under', 'about', 'above', 'below', 'between',
    'after', 'before', 'again', 'more', 'most', 'some', 'such', 'than', 'then',
    'there', 'here', 'just', 'only', 'very', 'too', 'also', 'been', 'being',
    'does', 'did', 'doing', 'each', 'few', 'get', 'got', 'let', 'per', 'via',
    'vs', 'etc', 'page', 'html', 'htm', 'php', 'aspx', 'index'
  ]);

  /**
   * Tokenize an arbitrary string into lowercase word tokens.
   * Words are runs of Unicode letters/digits (so "don't" -> ["don", "t"],
   * "cross-origin" -> ["cross", "origin"]).
   */
  function tokenizeText(text) {
    if (!text) return [];
    var matches = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu);
    return matches || [];
  }

  /**
   * Derive target keywords from a URL slug (last path segment).
   * Split on - and _ (and any non-alphanumeric), drop stopwords,
   * drop tokens shorter than 3 chars, drop pure numbers.
   * Keep a 1-4 token phrase (first 4 tokens if longer — slugs usually
   * lead with the head keyword).
   *
   * Returns { phrase, tokens } or null when nothing usable remains.
   */
  function slugToPhrase(slug) {
    if (!slug) return null;
    // Strip a file extension like .html/.php before splitting.
    var cleaned = String(slug).replace(/\.[a-z0-9]{1,5}$/i, '');
    var raw = tokenizeText(cleaned.replace(/[-_]+/g, ' '));
    var tokens = [];
    for (var i = 0; i < raw.length; i++) {
      var t = raw[i];
      if (t.length < 3) continue;
      if (/^[0-9]+$/.test(t)) continue;
      if (STOPWORDS.has(t)) continue;
      tokens.push(t);
      if (tokens.length === 4) break;
    }
    if (tokens.length === 0) return null;
    return { phrase: tokens.join(' '), tokens: tokens };
  }

  /**
   * Extract the last non-empty path segment of a URL string.
   * Returns '' for the homepage / no usable segment.
   */
  function lastPathSegment(urlString) {
    try {
      var u = new URL(urlString);
      var segs = u.pathname.split('/').filter(function (s) { return s.length > 0; });
      return segs.length ? decodeURIComponent(segs[segs.length - 1]) : '';
    } catch (e) {
      return '';
    }
  }

  /** Number of non-empty path segments — used for depth ranking. */
  function urlDepth(urlString) {
    try {
      var u = new URL(urlString);
      return u.pathname.split('/').filter(function (s) { return s.length > 0; }).length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Normalize a URL for identity comparison ("already linked", self-URL):
   * resolve against base, strip hash + query, lowercase host, collapse
   * trailing slash. Returns null for unparseable/non-http URLs.
   */
  function normalizeUrl(href, baseUrl) {
    try {
      var u = baseUrl ? new URL(href, baseUrl) : new URL(href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      var path = u.pathname.replace(/\/+$/, '');
      return u.protocol + '//' + u.host.toLowerCase() + (path || '/');
    } catch (e) {
      return null;
    }
  }

  ns.tokenizer = {
    STOPWORDS: STOPWORDS,
    tokenizeText: tokenizeText,
    slugToPhrase: slugToPhrase,
    lastPathSegment: lastPathSegment,
    urlDepth: urlDepth,
    normalizeUrl: normalizeUrl
  };
})(self.__linkLens = self.__linkLens || {});
