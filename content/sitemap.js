/**
 * Link Lens — content/sitemap.js
 * Discovers and parses the site's sitemap FROM THE CONTENT SCRIPT, so every
 * request is same-origin with the active tab (no CORS, no host permissions).
 *
 * Fallback chain:
 *   /sitemap.xml → /sitemap_index.xml → /wp-sitemap.xml → /sitemap-index.xml
 *   → Sitemap: lines in /robots.txt
 *
 * Sitemap INDEX files: fetch up to MAX_CHILDREN child sitemaps (most recent
 * by <lastmod> first). Total URL cap MAX_URLS, keeping the most recent by
 * <lastmod> when present. .xml.gz entries are skipped and counted.
 */
(function (ns) {
  'use strict';
  if (ns.sitemap) return; // idempotent re-injection guard

  var MAX_CHILDREN = 8;
  var MAX_URLS = 2000;
  var FETCH_TIMEOUT_MS = 10000;

  var SITEMAP_PATHS = [
    '/sitemap.xml',
    '/sitemap_index.xml',
    '/wp-sitemap.xml',
    '/sitemap-index.xml'
  ];

  function fetchText(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
    return fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function parseXml(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    return doc;
  }

  /** True when the document root is <sitemapindex>. */
  function isSitemapIndex(doc) {
    return !!doc && doc.documentElement &&
      doc.documentElement.localName === 'sitemapindex';
  }

  /**
   * Extract {loc, lastmod} entries from a <urlset> or <sitemapindex>.
   * lastmod is an epoch ms number or null.
   */
  function extractEntries(doc, tagName) {
    var out = [];
    var nodes = doc.getElementsByTagName(tagName);
    for (var i = 0; i < nodes.length; i++) {
      var locEl = nodes[i].getElementsByTagName('loc')[0];
      if (!locEl) continue;
      var loc = (locEl.textContent || '').trim();
      if (!loc) continue;
      var lastmod = null;
      var lmEl = nodes[i].getElementsByTagName('lastmod')[0];
      if (lmEl) {
        var t = Date.parse((lmEl.textContent || '').trim());
        if (!isNaN(t)) lastmod = t;
      }
      out.push({ loc: loc, lastmod: lastmod });
    }
    return out;
  }

  /**
   * Sort most-recent lastmod first; entries without lastmod keep order,
   * last. Lastmod ties break toward shorter URLs, so when the 2,000 cap
   * trims a large sitemap the original pages survive ahead of their
   * locale-prefixed duplicates (which share the same lastmod).
   */
  function sortByLastmodDesc(entries) {
    return entries.map(function (e, i) { return { e: e, i: i }; })
      .sort(function (a, b) {
        var la = a.e.lastmod, lb = b.e.lastmod;
        if (la === null && lb === null) return a.i - b.i;
        if (la === null) return 1;
        if (lb === null) return -1;
        if (lb !== la) return lb - la;
        if (a.e.loc.length !== b.e.loc.length) return a.e.loc.length - b.e.loc.length;
        return a.i - b.i;
      })
      .map(function (w) { return w.e; });
  }

  function isGz(url) { return /\.xml\.gz(\?|#|$)/i.test(url); }

  var LOCALE_PREFIX = /^\/[a-z]{2}(-[a-z]{2})?\//i;

  /**
   * Remove entries like /zh-cn/post-slug when /post-slug is also present.
   * Sites that put EVERYTHING under a locale prefix are unaffected (no
   * unprefixed sibling exists, so nothing is dropped).
   */
  function dropLocaleDuplicates(entries) {
    var keys = new Set();
    var i, k;
    for (i = 0; i < entries.length; i++) {
      k = ns.tokenizer.siteKey(entries[i].loc);
      if (k) keys.add(k);
    }
    var out = [];
    for (i = 0; i < entries.length; i++) {
      var loc = entries[i].loc;
      k = ns.tokenizer.siteKey(loc);
      var drop = false;
      if (k) {
        try {
          var path = new URL(loc).pathname;
          if (LOCALE_PREFIX.test(path)) {
            var host = k.split('/')[0];
            var strippedPath = path.replace(LOCALE_PREFIX, '/').replace(/\/+$/, '');
            var sibling = host + (strippedPath || '/');
            if (sibling !== k && keys.has(sibling)) drop = true;
          }
        } catch (e) { /* keep */ }
      }
      if (!drop) out.push(entries[i]);
    }
    return out;
  }

  // Same SITE, not same origin: sitemaps routinely list www.example.com
  // while the user browses example.com (or https vs http). Treating that
  // as cross-origin silently empties the whole index.
  function sameOrigin(url, origin) {
    return ns.tokenizer.sameSite(url, origin);
  }

  /** Parse Sitemap: lines out of robots.txt (same-origin only). */
  function sitemapsFromRobots(robotsText, origin) {
    var urls = [];
    var lines = robotsText.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*sitemap\s*:\s*(\S+)/i);
      if (m && sameOrigin(m[1], origin)) urls.push(m[1]);
    }
    return urls;
  }

  /**
   * Fetch + parse one sitemap URL. Recurses one level into sitemap
   * indexes. Returns { urls: [{loc,lastmod}], skippedGz, source }.
   * Rejects when the entry point can't be fetched/parsed.
   */
  function loadSitemap(entryUrl, origin, onProgress) {
    return fetchText(entryUrl).then(function (text) {
      var doc = parseXml(text);
      if (!doc) throw new Error('not valid XML');

      if (!isSitemapIndex(doc)) {
        var urls = extractEntries(doc, 'url');
        if (urls.length === 0) throw new Error('empty urlset');
        return { urls: urls, skippedGz: 0, children: 0 };
      }

      // Sitemap index: pick up to MAX_CHILDREN children, newest first,
      // skipping .xml.gz and cross-origin entries.
      var children = extractEntries(doc, 'sitemap');
      var skippedGz = 0;
      var usable = [];
      for (var i = 0; i < children.length; i++) {
        if (isGz(children[i].loc)) { skippedGz++; continue; }
        if (!sameOrigin(children[i].loc, origin)) continue;
        usable.push(children[i]);
      }
      usable = sortByLastmodDesc(usable).slice(0, MAX_CHILDREN);
      if (usable.length === 0) throw new Error('sitemap index has no usable children');

      var all = [];
      var chain = Promise.resolve();
      usable.forEach(function (child, idx) {
        chain = chain.then(function () {
          if (onProgress) {
            onProgress('Fetching child sitemap ' + (idx + 1) + '/' + usable.length + '…');
          }
          return fetchText(child.loc).then(function (childText) {
            var childDoc = parseXml(childText);
            if (!childDoc) return; // skip unparseable child, keep going
            var entries = extractEntries(childDoc, 'url');
            for (var j = 0; j < entries.length; j++) all.push(entries[j]);
          }).catch(function () { /* per-child failure: skip, keep batch */ });
        });
      });
      return chain.then(function () {
        if (all.length === 0) throw new Error('no URLs in child sitemaps');
        return { urls: all, skippedGz: skippedGz, children: usable.length };
      });
    });
  }

  /**
   * Walk the fallback chain and return the site's URL list.
   * Resolves { urls: [{loc,lastmod}], source, skippedGz, children } or
   * null when no sitemap could be found at all (caller falls back to
   * shallow mode).
   */
  function discover(origin, onProgress) {
    var attempts = SITEMAP_PATHS.map(function (p) { return origin + p; });

    function tryAt(i) {
      if (i >= attempts.length) return tryRobots();
      if (onProgress) onProgress('Trying ' + attempts[i].replace(origin, '') + '…');
      return loadSitemap(attempts[i], origin, onProgress).then(function (result) {
        result.source = attempts[i];
        return result;
      }).catch(function () {
        return tryAt(i + 1);
      });
    }

    function tryRobots() {
      if (onProgress) onProgress('Checking /robots.txt for Sitemap: lines…');
      return fetchText(origin + '/robots.txt').then(function (robots) {
        var urls = sitemapsFromRobots(robots, origin).filter(function (u) {
          return !isGz(u);
        });
        function tryRobotsAt(i) {
          if (i >= urls.length) return null;
          return loadSitemap(urls[i], origin, onProgress).then(function (result) {
            result.source = urls[i] + ' (via robots.txt)';
            return result;
          }).catch(function () {
            return tryRobotsAt(i + 1);
          });
        }
        return tryRobotsAt(0);
      }).catch(function () { return null; });
    }

    return tryAt(0).then(function (result) {
      if (!result) return null;
      // Also skip any .xml.gz page entries inside urlsets and count them.
      var kept = [];
      for (var i = 0; i < result.urls.length; i++) {
        if (isGz(result.urls[i].loc)) { result.skippedGz++; continue; }
        kept.push(result.urls[i]);
      }
      // Drop locale-prefixed duplicates (/zh-cn/post next to /post) BEFORE
      // capping, so translations don't crowd the originals out of the cap.
      kept = dropLocaleDuplicates(kept);
      // Enforce the total URL cap, keeping most recent by <lastmod>.
      if (kept.length > MAX_URLS) {
        kept = sortByLastmodDesc(kept).slice(0, MAX_URLS);
        result.capped = true;
      } else {
        result.capped = false;
      }
      result.urls = kept;
      return result;
    });
  }

  ns.sitemap = {
    MAX_CHILDREN: MAX_CHILDREN,
    MAX_URLS: MAX_URLS,
    discover: discover,
    // exported for the shallow-mode + bulk paths and for self-review clarity
    fetchText: fetchText,
    parseXml: parseXml
  };
})(self.__linkLens = self.__linkLens || {});
