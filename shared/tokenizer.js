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

  // Single-token targets that are too generic to suggest ("/about/", "/blog/").
  var GENERIC_SINGLE = new Set([
    'about', 'contact', 'home', 'blog', 'news', 'privacy', 'terms', 'legal',
    'login', 'signin', 'signup', 'register', 'search', 'sitemap', 'category',
    'categories', 'tag', 'tags', 'author', 'authors', 'archive', 'archives',
    'faq', 'faqs', 'help', 'support', 'careers', 'jobs', 'team', 'services',
    'products', 'shop', 'store', 'cart', 'checkout', 'account', 'feed'
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
   * Light stemmer so "researching keywords" matches "keyword-research".
   * Handles regular plurals, -ies/-y, -ing, -ed, trailing -e, and y→i,
   * which covers the inflections that actually appear in web copy.
   */
  function stem(w) {
    if (w.length < 4) return w;
    if (/ies$/.test(w) && w.length > 4) w = w.slice(0, -3) + 'y';
    else if (/s$/.test(w) && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
    if (/ing$/.test(w) && w.length > 5) {
      w = w.slice(0, -3);
      if (/([a-z])\1$/.test(w)) w = w.slice(0, -1); // running -> run
    } else if (/ed$/.test(w) && w.length > 4) {
      w = w.slice(0, -2);
      if (/([a-z])\1$/.test(w)) w = w.slice(0, -1);
    }
    if (/e$/.test(w) && w.length > 3) w = w.slice(0, -1); // price/pricing -> pric
    if (/y$/.test(w) && w.length > 3) w = w.slice(0, -1) + 'i'; // study/studies -> studi
    return w;
  }

  /**
   * Derive target keywords from a URL slug (last path segment).
   * Split on - and _ (and any non-alphanumeric), drop stopwords,
   * drop tokens shorter than 3 chars, drop pure numbers.
   * Keep a 1-4 token phrase (first 4 tokens if longer — slugs usually
   * lead with the head keyword).
   *
   * Returns { phrase, tokens, stems } or null when nothing usable remains.
   * Single-token targets that are generic page names (/about/, /blog/)
   * are dropped — they'd fire on every page.
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
    if (tokens.length === 1) {
      if (GENERIC_SINGLE.has(tokens[0])) return null;
      // A multi-word slug reduced to one surviving token ("ai-platform" ->
      // "platform") has lost its meaning — a single-word anchor for it
      // would be misleading, so drop the target.
      var meaningful = raw.filter(function (w) { return !/^[0-9]+$/.test(w); });
      if (meaningful.length >= 2) return null;
    }
    return { phrase: tokens.join(' '), tokens: tokens, stems: tokens.map(stem) };
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

  /**
   * Site-level identity of a URL, tolerant of the www/non-www and
   * http/https variants that make sitemap URLs differ from the address
   * bar (the #1 cause of "zero matches"). Ignores scheme, strips a
   * leading "www.", drops hash/query, collapses trailing slash.
   * Returns null for unparseable/non-http URLs.
   */
  function siteKey(href, baseUrl) {
    try {
      var u = baseUrl ? new URL(href, baseUrl) : new URL(href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      var host = u.host.toLowerCase().replace(/^www\./, '');
      var path = u.pathname.replace(/\/+$/, '');
      return host + (path || '/');
    } catch (e) {
      return null;
    }
  }

  /** True when two URLs belong to the same site (www/scheme tolerant). */
  function sameSite(urlA, urlB) {
    try {
      var ha = new URL(urlA).host.toLowerCase().replace(/^www\./, '');
      var hb = new URL(urlB).host.toLowerCase().replace(/^www\./, '');
      return ha === hb;
    } catch (e) {
      return false;
    }
  }

  ns.tokenizer = {
    STOPWORDS: STOPWORDS,
    tokenizeText: tokenizeText,
    stem: stem,
    slugToPhrase: slugToPhrase,
    lastPathSegment: lastPathSegment,
    urlDepth: urlDepth,
    normalizeUrl: normalizeUrl,
    siteKey: siteKey,
    sameSite: sameSite
  };
})(self.__linkLens = self.__linkLens || {});
