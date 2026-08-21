/**
 * Link Lens — content/indexer.js
 * Builds the per-origin target index: for each site URL, derive the slug
 * phrase to look for in page copy. Pure transforms over sitemap output,
 * plus the shallow fallback (same-origin links on the current page).
 */
(function (ns) {
  'use strict';
  if (ns.indexer) return; // idempotent re-injection guard

  var tok = ns.tokenizer;
  var MAX_URLS = 2000;

  /**
   * Convert [{loc, lastmod}] into targets:
   *   { url, normUrl, phrase, tokens[], depth }
   * URLs whose slug yields no usable tokens are dropped (nothing to match).
   * Deduped by normalized URL.
   */
  var LOCALE_PREFIX = /^\/[a-z]{2}(-[a-z]{2})?\//i;

  function buildTargets(entries, origin) {
    // First pass: collect every siteKey so locale-prefixed duplicates
    // (/zh-cn/post-slug next to /post-slug) can defer to the original.
    var allKeys = new Set();
    for (var p = 0; p < entries.length; p++) {
      var k = tok.siteKey(entries[p].loc);
      if (k) allKeys.add(k);
    }

    var seen = new Set();
    var targets = [];
    for (var i = 0; i < entries.length; i++) {
      var loc = entries[i].loc;
      var key = tok.siteKey(loc);
      if (!key || seen.has(key)) continue;
      // Skip a locale-prefixed URL when its unprefixed sibling is indexed too.
      try {
        var path = new URL(loc).pathname;
        if (LOCALE_PREFIX.test(path)) {
          var host = key.split('/')[0];
          var stripped = host + path.replace(LOCALE_PREFIX, '/').replace(/\/+$/, '');
          if ((stripped !== key) && allKeys.has(stripped || host + '/')) continue;
        }
      } catch (e) { /* keep the entry */ }
      // Same SITE (www/scheme tolerant) — sitemaps often list www.example.com
      // while the user browses example.com; strict origin checks empty the index.
      if (!tok.sameSite(loc, origin)) continue;
      var slug = tok.lastPathSegment(loc);
      var derived = tok.slugToPhrase(slug);
      // A slug that yields no phrase (/p/1234/, /?id=9) is kept anyway:
      // once the site is crawled its title and topic terms give it match
      // phrases. Until then it simply never matches.
      seen.add(key);
      targets.push({
        url: loc,
        siteKey: key,
        phrase: derived ? derived.phrase : '',
        tokens: derived ? derived.tokens : [],
        stems: derived ? derived.stems : [],
        depth: tok.urlDepth(loc)
      });
    }
    return targets;
  }

  /**
   * Shallow mode: no sitemap found. Index = all same-origin <a href>
   * URLs on the current page (deduped, capped).
   */
  function shallowEntries(doc, origin) {
    var anchors = doc.querySelectorAll('a[href]');
    var out = [];
    var seen = new Set();
    for (var i = 0; i < anchors.length && out.length < MAX_URLS; i++) {
      var href = anchors[i].getAttribute('href');
      if (!href) continue;
      var key = tok.siteKey(href, doc.baseURI);
      if (!key || seen.has(key)) continue;
      var abs;
      try { abs = new URL(href, doc.baseURI); } catch (e) { continue; }
      if (!tok.sameSite(abs.href, origin)) continue;
      seen.add(key);
      out.push({ loc: abs.href, lastmod: null });
    }
    return out;
  }

  /**
   * Build (or rebuild) the index for an origin. Tries the sitemap chain
   * first; falls back to shallow mode using the live document.
   * Resolves the full index object that storage.setIndex persists:
   *   { targets, source, shallow, skippedGz, capped, urlCount }
   */
  function build(origin, doc, onProgress) {
    return ns.sitemap.discover(origin, onProgress).then(function (result) {
      if (result) {
        var targets = buildTargets(result.urls, origin);
        return {
          targets: targets,
          source: result.source,
          shallow: false,
          skippedGz: result.skippedGz || 0,
          capped: !!result.capped,
          urlCount: result.urls.length
        };
      }
      if (onProgress) onProgress('No sitemap found — using same-origin links on this page (shallow mode).');
      var entries = shallowEntries(doc, origin);
      return {
        targets: buildTargets(entries, origin),
        source: 'shallow (links on ' + doc.location.pathname + ')',
        shallow: true,
        skippedGz: 0,
        capped: false,
        urlCount: entries.length
      };
    });
  }

  ns.indexer = {
    build: build,
    buildTargets: buildTargets,
    shallowEntries: shallowEntries
  };
})(self.__linkLens = self.__linkLens || {});
