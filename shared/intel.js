/**
 * Link Lens — shared/intel.js
 * The intelligence layer: turns a site crawl into a model, enriches link
 * targets with content-derived match phrases, scores opportunities, and
 * produces the audit reports (orphans, under-linked pages, anchor
 * diversity). Pure — no DOM, no chrome.*.
 */
(function (ns) {
  'use strict';
  if (ns.intel) return; // idempotent re-injection guard

  var ts = ns.textstats;
  var tok = ns.tokenizer;

  /**
   * Build the working model from a persisted crawl record.
   * crawl: { pages: {key: {t,h,d,w,k}}, df, inbound, anchors, done, ... }
   */
  function buildModel(crawl) {
    if (!crawl || !crawl.pages) return null;
    var keys = Object.keys(crawl.pages);
    if (keys.length === 0) return null;
    return {
      pages: crawl.pages,
      df: crawl.df || {},
      inbound: crawl.inbound || {},
      anchors: crawl.anchors || {},
      totalDocs: keys.length,
      coverage: { crawled: keys.length, total: crawl.total || keys.length },
      builtAt: crawl.updatedAt || crawl.startedAt || 0
    };
  }

  /** Median inbound count — the yardstick for "under-linked". */
  function medianInbound(model, targets) {
    var vals = targets.map(function (t) { return model.inbound[t.siteKey] || 0; });
    if (vals.length === 0) return 0;
    vals.sort(function (a, b) { return a - b; });
    return vals[Math.floor(vals.length / 2)];
  }

  /**
   * Enrich index targets with everything the crawl knows:
   *  - phrases[]: slug phrase + title/H1 phrase + top distinctive bigrams
   *  - vec: TF-IDF vector of the target page (for topical relevance)
   *  - inbound: internal links currently pointing at it
   * Targets without crawl data keep working on their slug phrase alone.
   */
  function enrich(targets, model) {
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var phrases = [];
      if (t.tokens && t.tokens.length) {
        phrases.push({
          tokens: t.tokens, stems: t.stems || t.tokens.map(tok.stem),
          kind: 'slug', weight: 1
        });
      }
      t.inbound = 0;
      t.vec = null;
      t.title = null;

      if (model) {
        var p = model.pages[t.siteKey];
        t.inbound = model.inbound[t.siteKey] || 0;
        if (p) {
          t.title = p.t || p.h || null;
          // Title / H1 phrase — catches targets with useless slugs.
          var head = ts.headingPhrase(p.h || p.t);
          if (head && !samePhrase(head.stems, phrases)) {
            phrases.push({ tokens: head.tokens, stems: head.stems, kind: 'title', weight: 0.9 });
            // Slug gave nothing (/p/1234/) — the title becomes its identity.
            if (!t.phrase) t.phrase = head.tokens.join(' ');
          }
          // Top distinctive bigrams from the page's own copy.
          var terms = p.k || [];
          t.vec = ts.vector(terms, model.df, model.totalDocs);
          var added = 0;
          for (var j = 0; j < terms.length && added < 2; j++) {
            var term = terms[j][0];
            if (term.indexOf(' ') === -1) continue;               // bigrams only
            if (ts.idf(model.df[term], model.totalDocs) < 1.2) continue; // too common
            var stems = term.split(' ');
            if (samePhrase(stems, phrases)) continue;
            phrases.push({ tokens: stems, stems: stems, kind: 'term', weight: 0.75 });
            added++;
          }
        }
      }
      t.phrases = phrases;
    }
    return targets;
  }

  function samePhrase(stems, phrases) {
    var joined = stems.join(' ');
    for (var i = 0; i < phrases.length; i++) {
      if (phrases[i].stems.join(' ') === joined) return true;
    }
    return false;
  }

  var TYPE_POINTS = { exact: 40, loose: 26, partial: 16 };

  /**
   * Score one opportunity 0-100 and explain it.
   *   match quality (0-40) + topical relevance (0-25) + link need (0-20)
   *   + placement (0-10) + phrase source (0-5) - anchor over-use penalty
   */
  function score(opts) {
    var s = opts.suggestion, t = opts.target, model = opts.model;
    var pts = TYPE_POINTS[s.matchType] || 10;
    var reasons = [];
    reasons.push(s.matchType + ' match');

    var relevance = 0;
    if (model && t.vec && opts.pageVec) {
      var sim = ts.cosine(opts.pageVec, t.vec);
      relevance = Math.round(Math.min(1, sim * 3) * 25); // sims are small; scale
      if (relevance >= 15) reasons.push('strong topical overlap');
      else if (relevance >= 7) reasons.push('related topic');
    }

    var need = 0;
    if (model) {
      var inbound = t.inbound || 0;
      var med = opts.medianInbound || 0;
      if (inbound === 0) { need = 20; reasons.push('orphan page — no internal links'); }
      else if (inbound <= Math.max(1, med / 2)) { need = 13; reasons.push('under-linked page'); }
      else if (inbound <= med) { need = 7; }
    }

    var place = s.position === 'early' ? 10 : (s.position === 'deep' ? 2 : 6);
    if (s.inHeading) place = Math.max(0, place - 5);

    var src = 0;
    var kind = s.phraseKind || 'slug';
    if (kind === 'slug') src = 5;
    else if (kind === 'title') { src = 4; reasons.push('matches target page title'); }
    else { src = 3; reasons.push('matches target page topic'); }

    var penalty = 0;
    if (model) {
      var used = anchorUsage(model, t.siteKey, s.anchorText);
      if (used.total >= 3 && used.share >= 0.6) {
        penalty = 10;
        reasons.push('anchor "' + used.dominant + '" already used on ' +
          Math.round(used.share * 100) + '% of links here — vary it');
      }
    }

    var total = Math.max(1, Math.min(100, pts + relevance + need + place + src - penalty));
    return { score: total, reasons: reasons };
  }

  /** How dominant is one anchor among a target's existing inbound anchors? */
  function anchorUsage(model, key, candidate) {
    var list = (model.anchors && model.anchors[key]) || [];
    var total = 0, top = null;
    for (var i = 0; i < list.length; i++) {
      total += list[i][1];
      if (!top || list[i][1] > top[1]) top = list[i];
    }
    if (!top || total === 0) return { total: 0, share: 0, dominant: null };
    var share = top[1] / total;
    var sameAsCandidate = candidate &&
      top[0].toLowerCase() === String(candidate).toLowerCase();
    return {
      total: total,
      share: sameAsCandidate ? share : share * 0.9, // still a diversity signal
      dominant: top[0]
    };
  }

  /* ------------------------------------------------------------------ *
   * Reports
   * ------------------------------------------------------------------ */

  /** Pages the crawl saw that nothing links to. */
  function orphanPages(model, targets) {
    var out = [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (!model.pages[t.siteKey]) continue; // not crawled — unknown, not orphan
      if ((model.inbound[t.siteKey] || 0) === 0) {
        out.push({
          url: t.url,
          title: t.title || t.phrase,
          words: (model.pages[t.siteKey].w) || 0,
          inbound: 0
        });
      }
    }
    return out;
  }

  /** Crawled pages sorted by how few internal links point at them. */
  function underLinked(model, targets, limit) {
    var rows = [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (!model.pages[t.siteKey]) continue;
      rows.push({
        url: t.url,
        title: t.title || t.phrase,
        inbound: model.inbound[t.siteKey] || 0,
        words: model.pages[t.siteKey].w || 0
      });
    }
    rows.sort(function (a, b) { return a.inbound - b.inbound; });
    return rows.slice(0, limit || 100);
  }

  /** Targets whose inbound anchors are dangerously uniform. */
  function anchorRisks(model, targets, limit) {
    var rows = [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var list = (model.anchors && model.anchors[t.siteKey]) || [];
      if (list.length === 0) continue;
      var total = 0, top = null;
      for (var j = 0; j < list.length; j++) {
        total += list[j][1];
        if (!top || list[j][1] > top[1]) top = list[j];
      }
      if (total < 3) continue;
      var share = top[1] / total;
      if (share < 0.7) continue;
      rows.push({
        url: t.url,
        anchor: top[0],
        uses: top[1],
        total: total,
        share: Math.round(share * 100),
        variants: list.length
      });
    }
    rows.sort(function (a, b) { return b.uses - a.uses; });
    return rows.slice(0, limit || 100);
  }

  ns.intel = {
    buildModel: buildModel,
    enrich: enrich,
    score: score,
    medianInbound: medianInbound,
    orphanPages: orphanPages,
    underLinked: underLinked,
    anchorRisks: anchorRisks
  };
})(self.__linkLens = self.__linkLens || {});
