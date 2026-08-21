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
      ids: crawl.ids || {},
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

  /**
   * Internal authority flow (PageRank over EDITORIAL links only).
   * Needs a v2 crawl (per-page out-edges); returns null otherwise.
   * Scores are normalized so the average page scores 1.0 — "0.3" reads
   * as "gets a third of an average page's internal authority".
   */
  function authority(model) {
    var keys = Object.keys(model.pages);
    var n = keys.length;
    if (n === 0) return null;
    var hasEdges = keys.some(function (k) { return Array.isArray(model.pages[k].o); });
    if (!hasEdges) return null;

    // id -> key (only ids that correspond to crawled pages participate)
    var ids = model.ids || {};
    var idToIndex = {};
    for (var i = 0; i < n; i++) {
      var id = ids[keys[i]];
      if (id !== undefined) idToIndex[id] = i;
    }

    var out = [];
    for (i = 0; i < n; i++) {
      var edges = model.pages[keys[i]].o || [];
      var targets = [];
      for (var e = 0; e < edges.length; e++) {
        var idx = idToIndex[edges[e]];
        if (idx !== undefined && idx !== i) targets.push(idx);
      }
      out.push(targets);
    }

    var rank = new Array(n).fill(1 / n);
    var damping = 0.85;
    for (var iter = 0; iter < 25; iter++) {
      var next = new Array(n).fill((1 - damping) / n);
      var dangling = 0;
      for (i = 0; i < n; i++) {
        if (out[i].length === 0) { dangling += rank[i]; continue; }
        var share = damping * rank[i] / out[i].length;
        for (var t = 0; t < out[i].length; t++) next[out[i][t]] += share;
      }
      if (dangling > 0) {
        var spread = damping * dangling / n;
        for (i = 0; i < n; i++) next[i] += spread;
      }
      rank = next;
    }

    var scores = {};
    for (i = 0; i < n; i++) scores[keys[i]] = rank[i] * n; // average = 1.0
    return scores;
  }

  /**
   * Keyword cannibalization: pairs of pages whose topic vectors are
   * near-identical, i.e. two pages competing for the same query.
   * Candidates are generated from shared top terms, so this stays fast
   * on big sites instead of comparing every page with every other.
   */
  function cannibalization(model, targets, opts) {
    opts = opts || {};
    var threshold = opts.threshold || 0.72;
    var limit = opts.limit || 60;

    var byKey = {};
    for (var i = 0; i < targets.length; i++) byKey[targets[i].siteKey] = targets[i];

    var keys = Object.keys(model.pages);
    var vecs = {}, postings = {};
    for (i = 0; i < keys.length; i++) {
      var k = keys[i];
      var page = model.pages[k];
      if (!page.k || page.k.length === 0) continue;
      vecs[k] = ts.vector(page.k, model.df, model.totalDocs);
      // index the page under its 8 most distinctive terms
      for (var j = 0; j < Math.min(8, page.k.length); j++) {
        var term = page.k[j][0];
        (postings[term] || (postings[term] = [])).push(k);
      }
    }

    var seenPair = new Set();
    var pairs = [];
    // A term shared by a large slice of the site is a theme, not a
    // duplicate signal — skip it, but scale the cutoff with site size so
    // legitimate clusters on big sites still get compared.
    var termCap = Math.max(40, Math.round(model.totalDocs * 0.05));
    Object.keys(postings).forEach(function (term) {
      var list = postings[term];
      if (list.length > termCap) return;
      for (var a = 0; a < list.length; a++) {
        for (var b = a + 1; b < list.length; b++) {
          var pairKey = list[a] < list[b] ? list[a] + '|' + list[b] : list[b] + '|' + list[a];
          if (seenPair.has(pairKey)) continue;
          seenPair.add(pairKey);
          var sim = ts.cosine(vecs[list[a]], vecs[list[b]]);
          if (sim < threshold) continue;
          var ta = byKey[list[a]], tb = byKey[list[b]];
          pairs.push({
            urlA: ta ? ta.url : list[a],
            urlB: tb ? tb.url : list[b],
            titleA: (model.pages[list[a]].t || model.pages[list[a]].h || ''),
            titleB: (model.pages[list[b]].t || model.pages[list[b]].h || ''),
            similarity: Math.round(sim * 100),
            inboundA: model.inbound[list[a]] || 0,
            inboundB: model.inbound[list[b]] || 0
          });
        }
      }
    });
    pairs.sort(function (x, y) { return y.similarity - x.similarity; });
    return pairs.slice(0, limit);
  }

  ns.intel = {
    buildModel: buildModel,
    authority: authority,
    cannibalization: cannibalization,
    enrich: enrich,
    score: score,
    medianInbound: medianInbound,
    orphanPages: orphanPages,
    underLinked: underLinked,
    anchorRisks: anchorRisks
  };
})(self.__linkLens = self.__linkLens || {});
