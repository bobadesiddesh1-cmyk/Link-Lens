/**
 * Link Lens — shared/gsc.js
 * Google Search Console: property matching and the query→page model.
 *
 * Everything here is PURE (no chrome.*, no fetch) so it runs in node
 * tests, the panel and the service worker alike. The actual OAuth and
 * HTTP live in background.js; this file decides which property belongs
 * to the site you are on and turns the API's rows into the keyword map
 * the rest of the intelligence layer consumes.
 *
 * Why this matters: until now a URL's "primary keyword" was inferred
 * from its slug or H1 — a guess about what the page is *for*. Search
 * Console knows what it actually ranks for, which queries carry demand,
 * and at what position. That turns anchor→URL mapping from inference
 * into evidence.
 */
(function (ns) {
  'use strict';
  if (ns.gsc) return; // idempotent re-injection guard

  var tok = ns.tokenizer;

  var GSC_VERSION = 1;
  var MAX_QUERIES_PER_PAGE = 10;
  var MAX_PAGES = 5000;

  /* ------------------------------------------------------------------ *
   * Property matching
   * ------------------------------------------------------------------ */

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
    catch (e) { return null; }
  }

  /**
   * Which of the user's GSC properties covers the site they're on?
   * Ranked: exact URL-prefix > domain property > www/scheme variant.
   * Properties the user can't read (siteUnverifiedUser) are ignored.
   */
  function matchProperty(properties, origin) {
    var host = hostOf(origin);
    if (!host || !properties) return null;
    var best = null, bestRank = 0;
    for (var i = 0; i < properties.length; i++) {
      var p = properties[i];
      var siteUrl = p.siteUrl || p;
      var level = p.permissionLevel || 'siteOwner';
      if (level === 'siteUnverifiedUser') continue;
      var rank = 0;
      if (siteUrl.indexOf('sc-domain:') === 0) {
        var domain = siteUrl.slice('sc-domain:'.length).toLowerCase();
        // A domain property also covers every subdomain.
        if (host === domain || host.slice(-(domain.length + 1)) === '.' + domain) rank = 2;
      } else {
        var pHost = hostOf(siteUrl);
        if (pHost !== host) continue;
        try {
          rank = (new URL(siteUrl).origin === origin) ? 3 : 1; // exact vs www/scheme variant
        } catch (e) { rank = 1; }
      }
      if (rank > bestRank) { bestRank = rank; best = siteUrl; }
    }
    return best;
  }

  /** Human label for a property string. */
  function propertyLabel(siteUrl) {
    if (!siteUrl) return '';
    return siteUrl.indexOf('sc-domain:') === 0
      ? siteUrl.slice('sc-domain:'.length) + ' (domain property)'
      : siteUrl;
  }

  /* ------------------------------------------------------------------ *
   * The query → page model
   * ------------------------------------------------------------------ */

  /**
   * Fold Search Analytics rows (dimensions: page, query) into a per-page
   * record keyed by siteKey, so it joins straight onto the crawl and the
   * site index.
   *
   * Rows arrive one per (page, query) pair; we keep the top queries per
   * page by clicks, then impressions. Storing every query for every page
   * of a large site would blow the storage budget for no benefit — the
   * long tail below the top ten never decides an anchor.
   */
  function buildModel(rows, opts) {
    opts = opts || {};
    var pages = {};
    var totals = { clicks: 0, impressions: 0, rows: 0 };
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      var keys = r.keys || [];
      var pageUrl = keys[0], query = keys[1];
      if (!pageUrl || !query) continue;
      var key = tok.siteKey(pageUrl);
      if (!key) continue;
      var page = pages[key];
      if (!page) {
        if (Object.keys(pages).length >= (opts.maxPages || MAX_PAGES)) continue;
        page = pages[key] = { u: pageUrl, q: [], c: 0, i: 0 };
      }
      var clicks = r.clicks || 0, impressions = r.impressions || 0;
      page.q.push([query, clicks, impressions, Math.round((r.position || 0) * 10) / 10]);
      page.c += clicks;
      page.i += impressions;
      totals.clicks += clicks;
      totals.impressions += impressions;
      totals.rows++;
    }
    var limit = opts.maxQueriesPerPage || MAX_QUERIES_PER_PAGE;
    var keysOut = Object.keys(pages);
    for (var k = 0; k < keysOut.length; k++) {
      var pg = pages[keysOut[k]];
      pg.q.sort(function (a, b) {
        if (b[1] !== a[1]) return b[1] - a[1];          // clicks
        if (b[2] !== a[2]) return b[2] - a[2];          // impressions
        return a[3] - b[3];                              // better position
      });
      pg.q = pg.q.slice(0, limit);
    }
    return {
      version: GSC_VERSION,
      property: opts.property || null,
      startDate: opts.startDate || null,
      endDate: opts.endDate || null,
      updatedAt: Date.now(),
      pages: pages,
      totals: { clicks: totals.clicks, impressions: totals.impressions,
                pages: keysOut.length, rows: totals.rows }
    };
  }

  /** Rebuild the stem index lazily: stem string → [{key, row}] for lookups. */
  function queryIndex(model) {
    if (!model) return null;
    if (model.__index) return model.__index;
    var idx = new Map();
    var keys = Object.keys(model.pages || {});
    for (var i = 0; i < keys.length; i++) {
      var rows = model.pages[keys[i]].q || [];
      for (var j = 0; j < rows.length; j++) {
        var stems = queryStems(rows[j][0]).join(' ');
        if (!stems) continue;
        var list = idx.get(stems);
        if (!list) { list = []; idx.set(stems, list); }
        list.push({ key: keys[i], row: rows[j] });
      }
    }
    Object.defineProperty(model, '__index', { value: idx, enumerable: false, writable: true });
    return idx;
  }

  /** Stem a query the same way the matcher stems page words. */
  function queryStems(text) {
    return tok.tokenizeText(String(text || ''))
      .filter(function (w) { return !tok.STOPWORDS.has(w); })
      .map(tok.stem);
  }

  /**
   * The page Google already ranks for this keyword — the single most
   * reliable answer to "what should this anchor link to?".
   * Returns { key, query, clicks, impressions, position } or null.
   */
  function targetForQuery(model, stems) {
    if (!model || !stems || stems.length === 0) return null;
    var idx = queryIndex(model);
    var hits = idx.get(stems.join(' '));
    if (!hits || hits.length === 0) return null;
    var best = null;
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      // Most clicks wins; impressions then position break ties. When two
      // pages rank for one query that IS cannibalization — we link to the
      // one Google already prefers rather than reinforcing the split.
      if (!best || h.row[1] > best.row[1] ||
          (h.row[1] === best.row[1] && h.row[2] > best.row[2])) best = h;
    }
    return {
      key: best.key,
      query: best.row[0],
      clicks: best.row[1],
      impressions: best.row[2],
      position: best.row[3],
      competing: hits.length
    };
  }

  /** Everything GSC knows about one page. */
  function forPage(model, key) {
    if (!model || !model.pages) return null;
    return model.pages[key] || null;
  }

  /**
   * Queries this page ranks for that contain the keyword — real search
   * demand, the best possible source of anchor variations.
   */
  function relatedQueries(model, key, stems, limit) {
    var page = forPage(model, key);
    if (!page) return [];
    var out = [];
    for (var i = 0; i < page.q.length && out.length < (limit || 8); i++) {
      var row = page.q[i];
      var qs = queryStems(row[0]);
      var covered = stems.every(function (s) { return qs.indexOf(s) !== -1; });
      if (!covered) continue;
      if (qs.join(' ') === stems.join(' ')) continue; // the keyword itself
      out.push({ text: row[0], clicks: row[1], impressions: row[2], position: row[3] });
    }
    return out;
  }

  /**
   * Striking distance: the page ranks on page 1-2 but not at the top, so
   * an internal link is the cheapest push available. Positions better
   * than 3 need no help; past 20 a link alone won't fix it.
   */
  function strikingDistance(page) {
    if (!page || !page.q || page.q.length === 0) return null;
    var best = null;
    for (var i = 0; i < page.q.length; i++) {
      var row = page.q[i];
      if (row[3] < 3.5 || row[3] > 20.5) continue;
      if (!best || row[2] > best[2]) best = row; // most impressions
    }
    if (!best) return null;
    return { query: best[0], impressions: best[2], position: best[3] };
  }

  /**
   * REAL cannibalization: two or more URLs ranking for the same query.
   * The TF-IDF version infers that two pages look alike; this reports
   * what Google is actually doing, which is what a client acts on.
   * Only queries with meaningful demand count — a stray impression on a
   * second URL is noise, not a competing page.
   */
  function cannibalQueries(model, opts) {
    opts = opts || {};
    var minImpressions = opts.minImpressions || 50;
    var limit = opts.limit || 100;
    var byQuery = new Map();
    var keys = Object.keys((model && model.pages) || {});
    for (var i = 0; i < keys.length; i++) {
      var rows = model.pages[keys[i]].q || [];
      for (var j = 0; j < rows.length; j++) {
        var q = rows[j][0];
        var list = byQuery.get(q);
        if (!list) { list = []; byQuery.set(q, list); }
        list.push({ key: keys[i], url: model.pages[keys[i]].u,
                    clicks: rows[j][1], impressions: rows[j][2], position: rows[j][3] });
      }
    }
    var out = [];
    byQuery.forEach(function (pages, query) {
      if (pages.length < 2) return;
      var total = 0;
      for (var k = 0; k < pages.length; k++) total += pages[k].impressions;
      if (total < minImpressions) return;
      pages.sort(function (a, b) {
        if (b.clicks !== a.clicks) return b.clicks - a.clicks;
        return a.position - b.position;
      });
      out.push({
        query: query,
        pages: pages,
        winner: pages[0],
        competitors: pages.length - 1,
        impressions: total,
        // How evenly the clicks are split: an even split is the worst case,
        // because neither URL is consolidating the signal.
        split: pages[0].clicks === 0 ? 1
          : Math.round((1 - pages[0].clicks / pages.reduce(function (a, p) { return a + p.clicks; }, 0)) * 100)
      });
    });
    out.sort(function (a, b) { return b.impressions - a.impressions; });
    return out.slice(0, limit);
  }

  /**
   * Quick wins: pages ranking just off the top — where an internal link
   * is the cheapest intervention available. Sorted by the impressions at
   * stake, because position 8 on 40,000 impressions beats position 5 on 300.
   */
  function quickWins(model, opts) {
    opts = opts || {};
    var minImpressions = opts.minImpressions || 100;
    var limit = opts.limit || 100;
    var out = [];
    var keys = Object.keys((model && model.pages) || {});
    for (var i = 0; i < keys.length; i++) {
      var page = model.pages[keys[i]];
      var best = strikingDistance(page);
      if (!best || best.impressions < minImpressions) continue;
      out.push({
        key: keys[i], url: page.u, query: best.query,
        position: best.position, impressions: best.impressions,
        clicks: page.c
      });
    }
    out.sort(function (a, b) { return b.impressions - a.impressions; });
    return out.slice(0, limit);
  }

  ns.gsc = {
    cannibalQueries: cannibalQueries,
    quickWins: quickWins,
    VERSION: GSC_VERSION,
    MAX_QUERIES_PER_PAGE: MAX_QUERIES_PER_PAGE,
    matchProperty: matchProperty,
    propertyLabel: propertyLabel,
    buildModel: buildModel,
    queryStems: queryStems,
    targetForQuery: targetForQuery,
    relatedQueries: relatedQueries,
    strikingDistance: strikingDistance,
    forPage: forPage
  };
})(self.__linkLens = self.__linkLens || {});
