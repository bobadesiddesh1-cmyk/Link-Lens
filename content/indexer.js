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
  function buildTargets(entries, origin) {
    var seen = new Set();
    var targets = [];
    for (var i = 0; i < entries.length; i++) {
      var loc = entries[i].loc;
      var norm = tok.normalizeUrl(loc);
      if (!norm || seen.has(norm)) continue;
      if (new URL(loc).origin !== origin) continue; // same-origin only
      var slug = tok.lastPathSegment(loc);
      var derived = tok.slugToPhrase(slug);
      if (!derived) continue;
      seen.add(norm);
      targets.push({
        url: loc,
        normUrl: norm,
        phrase: derived.phrase,
        tokens: derived.tokens,
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
      var norm = tok.normalizeUrl(href, doc.baseURI);
      if (!norm) continue;
      var abs;
      try { abs = new URL(href, doc.baseURI); } catch (e) { continue; }
      if (abs.origin !== origin) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
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
