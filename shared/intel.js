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
      // The keyword map: every URL has ONE primary keyword that anchors
      // should be (or closely vary). Slug by default; the H1/title wins
      // once the page has been crawled because it's what the page is
      // actually optimized for.
      t.primary = t.phrase || '';

      if (model) {
        var p = model.pages[t.siteKey];
        t.inbound = model.inbound[t.siteKey] || 0;
        if (p) {
          t.title = p.t || p.h || null;
          // Title / H1 phrase — catches targets with useless slugs.
          var head = ts.headingPhrase(p.h || p.t);
          if (head) {
            // Primary keyword = the heading as written (minus the site
            // name and edge stopwords), e.g. "apply for savings account
            // online". Matching phrases drop weak words; the keyword map
            // keeps them because "apply" IS the intent of that page.
            t.primary = headingKeyword(p.h || p.t) || head.tokens.join(' ');
            t.primaryStems = tok.tokenizeText(t.primary)
              .filter(function (w) { return !tok.STOPWORDS.has(w); }).map(tok.stem);
            if (!samePhrase(head.stems, phrases)) {
              // Title phrase outranks the slug phrase for matching.
              phrases.unshift({ tokens: head.tokens, stems: head.stems, kind: 'title', weight: 1 });
            }
            // Slug gave nothing (/p/1234/) — the title becomes its identity.
            if (!t.phrase) t.phrase = t.primary;
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

  /** Heading text → keyword: first segment before " | " etc., ≤6 words, no edge stopwords. */
  function headingKeyword(text) {
    if (!text) return '';
    var head = String(text).split(/\s[|–—:·]\s/)[0];
    var words = tok.tokenizeText(head).filter(function (w) { return !/^[0-9]+$/.test(w); });
    while (words.length && tok.STOPWORDS.has(words[0])) words.shift();
    while (words.length && tok.STOPWORDS.has(words[words.length - 1])) words.pop();
    if (words.length > 6) words = words.slice(0, 6);
    return words.length >= 2 ? words.join(' ') : '';
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
    var sim = null;
    if (model && t.vec && opts.pageVec) {
      sim = ts.cosine(opts.pageVec, t.vec);
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
    return { score: total, reasons: reasons, sim: sim };
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
   * How common a single word is across the crawled site (0..1). Used to
   * refuse single-word anchors like "offered" or "account" that appear on
   * most pages — those map to a URL by accident, not by topic.
   */
  function stemCommonness(model, stem) {
    if (!model || !model.df || !model.totalDocs) return 0;
    return (model.df[stem] || 0) / model.totalDocs;
  }

  /**
   * Best link target for a keyword: the index page whose primary keyword
   * / phrases overlap the keyword's stems the most (shallowest wins ties).
   */
  function pickTarget(targets, keywordStems) {
    var stems = keywordStems.filter(function (s) { return !tok.STOPWORDS.has(s); });
    if (stems.length === 0) return null;
    var best = null, bestScore = 0;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var phrases = (t.phrases || [{ stems: t.stems || [] }]).slice();
      if (t.primaryStems && t.primaryStems.length) phrases.push({ stems: t.primaryStems });
      var top = 0;
      for (var p = 0; p < phrases.length; p++) {
        var hit = 0;
        var ps = phrases[p].stems || [];
        for (var s = 0; s < ps.length; s++) if (stems.indexOf(ps[s]) !== -1) hit++;
        // reward full coverage of the keyword AND of the phrase
        var cover = stems.length ? hit / stems.length : 0;
        var tight = ps.length ? hit / ps.length : 0;
        var sc = hit + cover + tight;
        if (sc > top) top = sc;
      }
      if (top > bestScore || (top === bestScore && best && top > 0 && t.depth < best.depth)) {
        best = t; bestScore = top;
      }
    }
    return bestScore >= 1 ? best : null;
  }

  /* ------------------------------------------------------------------ *
   * Keyword variations
   * ------------------------------------------------------------------ */

  var INTENT_TEMPLATES = [
    'apply for {kw}', 'open {kw}', '{kw} online', 'how to open {kw}',
    '{kw} eligibility', '{kw} benefits', '{kw} interest rate', 'best {kw}',
    '{kw} charges', '{kw} requirements', 'compare {kw}', '{kw} guide'
  ];

  /**
   * Suggest anchor-text variations for a keyword, mined from the site
   * itself where possible:
   *   title   — phrases from crawled page titles/H1s that contain the
   *             keyword (or most of it): "Apply for Savings Account Online"
   *   anchor  — anchor texts already used site-wide for the target page
   *   related — other multi-word titles sharing a keyword stem
   *             ("bank account", "savings account types")
   *   template— intent phrasings ("apply for savings account") — marked
   *             as suggestions since they're not proven on the site
   * Returns [{ text, source, count }], best first, max `limit`.
   */
  function keywordVariants(model, keyword, targetKey, limit) {
    limit = limit || 12;
    var raw = tok.tokenizeText(keyword).filter(function (w) { return w.length >= 2; });
    var stems = raw.map(tok.stem);
    var need = stems.length;
    var out = [];
    var seen = new Set();
    var base = raw.join(' ');

    function add(text, source, count) {
      var clean = String(text).replace(/\s+/g, ' ').trim();
      var key = clean.toLowerCase();
      if (!clean || key === base || seen.has(key)) return;
      if (tok.tokenizeText(clean).length > 6) return; // anchors stay short
      seen.add(key);
      out.push({ text: clean, source: source, count: count || 1 });
    }

    if (model) {
      // 1. Anchors already used for the target — proven phrasing.
      if (targetKey && model.anchors && model.anchors[targetKey]) {
        model.anchors[targetKey].forEach(function (a) {
          if (/^(read more|click here|here|learn more|this|link)$/i.test(a[0])) return;
          add(a[0], 'anchor', a[1]);
        });
      }

      // 2. Titles / H1s across the site that contain the keyword, or
      //    share most of its stems.
      var titleHits = {};
      Object.keys(model.pages).forEach(function (k) {
        var p = model.pages[k];
        var text = (p.h || p.t || '').split(/\s[|–—:·]\s/)[0];
        if (!text) return;
        var words = tok.tokenizeText(text);
        var wstems = words.map(tok.stem);
        var shared = 0;
        for (var i = 0; i < stems.length; i++) if (wstems.indexOf(stems[i]) !== -1) shared++;
        if (shared === 0) return;
        var full = shared === need;
        // Take the window from the first shared stem to the last, padded
        // by one word each side, so "Apply for Savings Account Online"
        // survives intact.
        var first = -1, last = -1;
        for (var j = 0; j < wstems.length; j++) {
          if (stems.indexOf(wstems[j]) !== -1) { if (first === -1) first = j; last = j; }
        }
        var s = Math.max(0, first - 2), e = Math.min(words.length - 1, last + 2);
        var phrase = words.slice(s, e + 1)
          .filter(function (w) { return !/^[0-9]+$/.test(w); }).join(' ');
        // trim leading/trailing stopwords
        var parts = phrase.split(' ');
        while (parts.length && tok.STOPWORDS.has(parts[0])) parts.shift();
        while (parts.length && tok.STOPWORDS.has(parts[parts.length - 1])) parts.pop();
        if (parts.length < 2) return;
        var key = parts.join(' ');
        var slot = titleHits[key] || (titleHits[key] = { count: 0, full: full });
        slot.count++;
        if (full) slot.full = true;
      });
      Object.keys(titleHits)
        .sort(function (a, b) {
          var A = titleHits[a], B = titleHits[b];
          if (A.full !== B.full) return A.full ? -1 : 1;
          return B.count - A.count;
        })
        .forEach(function (phrase) {
          add(phrase, titleHits[phrase].full ? 'title' : 'related', titleHits[phrase].count);
        });
    }

    // 3. Intent templates — always available, clearly labelled.
    INTENT_TEMPLATES.forEach(function (tpl) {
      add(tpl.replace('{kw}', base), 'template', 0);
    });

    // proven sources first, then related, then templates
    var order = { anchor: 0, title: 1, related: 2, template: 3 };
    out.sort(function (a, b) {
      if (order[a.source] !== order[b.source]) return order[a.source] - order[b.source];
      return b.count - a.count;
    });
    return out.slice(0, limit);
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
   * Click depth from the homepage, following EDITORIAL links only
   * (breadth-first over the crawl's edge graph). Pages more than ~3
   * clicks deep are the classic "buried content" problem. Returns
   * { key: depth } with unreachable crawled pages marked Infinity, or
   * null on a v1 crawl that has no edges.
   */
  function clickDepth(model) {
    var keys = Object.keys(model.pages);
    if (keys.length === 0) return null;
    var hasEdges = keys.some(function (k) { return Array.isArray(model.pages[k].o); });
    if (!hasEdges) return null;

    var ids = model.ids || {};
    var idToKey = {};
    keys.forEach(function (k) {
      var id = ids[k];
      if (id !== undefined) idToKey[id] = k;
    });

    // The homepage is the shallowest key (host with no path, or "/").
    var root = null;
    for (var i = 0; i < keys.length; i++) {
      var path = keys[i].slice(keys[i].indexOf('/'));
      if (path === '/' || path === '') { root = keys[i]; break; }
    }
    if (!root) {
      root = keys.slice().sort(function (a, b) { return a.length - b.length; })[0];
    }

    var depth = {};
    keys.forEach(function (k) { depth[k] = Infinity; });
    depth[root] = 0;
    var queue = [root];
    while (queue.length) {
      var cur = queue.shift();
      var edges = (model.pages[cur] && model.pages[cur].o) || [];
      for (var e = 0; e < edges.length; e++) {
        var next = idToKey[edges[e]];
        if (next === undefined || depth[next] !== Infinity) continue;
        depth[next] = depth[cur] + 1;
        queue.push(next);
      }
    }
    return depth;
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
    stemCommonness: stemCommonness,
    pickTarget: pickTarget,
    keywordVariants: keywordVariants,
    authority: authority,
    clickDepth: clickDepth,
    cannibalization: cannibalization,
    enrich: enrich,
    score: score,
    medianInbound: medianInbound,
    orphanPages: orphanPages,
    underLinked: underLinked,
    anchorRisks: anchorRisks
  };
})(self.__linkLens = self.__linkLens || {});
