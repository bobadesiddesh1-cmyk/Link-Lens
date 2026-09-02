/**
 * Link Lens — crawler/planner.js  (runs in the offscreen document)
 *
 * One background page-processing engine, three modes:
 *
 *   plan     — SITE-WIDE LINK PLAN: re-read every crawled page, run the
 *              full matcher, keep the best opportunities under editorial
 *              guardrails (per-page and per-target caps, score floor).
 *   audit    — BULK AUDIT: the user's own URL list (up to 500), every
 *              opportunity per page, no caps — it's an audit, not a plan.
 *   keywords — SITE-WIDE KEYWORD CHECK: for one or more keywords, find
 *              every page on the site that mentions a keyword (or a
 *              chosen variation) but does not yet link its target.
 *
 * All modes fetch politely, persist progress so they survive the panel
 * closing or the service worker restarting, and can be paused/resumed.
 *
 * Why re-fetch instead of reusing the crawl: placing an anchor needs the
 * page's real sentences, and the crawl deliberately stores only the top
 * terms per page (full text for 2,000 pages would blow the storage
 * budget many times over).
 */
(function (ns) {
  'use strict';

  var tok = ns.tokenizer;

  var PLAN_VERSION = 2;
  var PERSIST_EVERY = 6;
  var FETCH_TIMEOUT = 15000;
  var KEYS = { plan: 'll_plan:', audit: 'll_audit:', keywords: 'll_kwsite:' };

  var state = null;
  var running = false;
  var stopRequested = false;
  var sincePersist = 0;
  var ctx = null;      // { targets, model, perTarget, keywords }

  function storageKey(mode, origin) { return (KEYS[mode] || KEYS.plan) + origin; }

  function get(key) {
    return chrome.storage.local.get(key).then(function (o) { return o[key] || null; });
  }

  function persist() {
    if (!state) return Promise.resolve();
    state.updatedAt = Date.now();
    var obj = {};
    obj[storageKey(state.mode, state.origin)] = state;
    return chrome.storage.local.set(obj).catch(function (e) {
      state.status = 'error';
      state.lastError = String(e && e.message || e);
      running = false;
    });
  }

  function report(extra) {
    var msg = {
      type: 'LL_PLAN_PROGRESS',
      mode: state.mode,
      origin: state.origin,
      status: state.status,
      done: state.done,
      failed: state.failed,
      total: state.total,
      links: state.rows.length
    };
    if (extra) Object.assign(msg, extra);
    chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; });
  }

  function fetchPage(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT);
    return fetch(url, { credentials: 'include', redirect: 'follow', signal: controller.signal })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct && ct.indexOf('html') === -1) throw new Error('not HTML');
        return res.text();
      }, function (err) {
        clearTimeout(timer);
        throw (err && err.name === 'AbortError') ? new Error('timeout') : err;
      });
  }

  /* ------------------------------------------------------------------ *
   * Per-page work
   * ------------------------------------------------------------------ */

  /** How many new links this page can absorb without looking spammy. */
  function budgetFor(pageKey) {
    if (state.mode === 'audit') return state.maxPerPage;
    var page = ctx.model && ctx.model.pages[pageKey];
    var words = (page && page.w) || 0;
    var byLength = Math.max(1, Math.floor(words / 200));
    return Math.min(state.maxPerPage, byLength);
  }

  function opportunitiesPage(url, doc) {
    var result = ns.matcher.match({
      doc: doc, pageUrl: url, targets: ctx.targets, model: ctx.model
    });
    var budget = budgetFor(tok.siteKey(url));
    var taken = 0;
    for (var i = 0; i < result.suggestions.length && taken < budget; i++) {
      var s = result.suggestions[i];
      if (s.score != null && s.score < state.minScore) continue;
      var tKey = tok.siteKey(s.url);
      var used = ctx.perTarget[tKey] || 0;
      if (used >= state.maxPerTarget) continue; // spread the link equity
      ctx.perTarget[tKey] = used + 1;
      taken++;
      state.rows.push([
        url, s.anchorText, s.url, s.keyword || '', s.title || '',
        s.score == null ? '' : s.score,
        s.matchType, s.position || 'body',
        s.inbound == null ? '' : s.inbound,
        s.gscPosition == null ? '' : s.gscPosition,
        s.gscClicks == null ? '' : s.gscClicks,
        (s.reasons || []).join('; '),
        s.contextSentence
      ]);
    }
    return taken;
  }

  function keywordsPage(url, doc) {
    var found = 0;
    for (var i = 0; i < ctx.keywords.length; i++) {
      var kw = ctx.keywords[i];
      if (kw.targetKey && tok.siteKey(url) === kw.targetKey) continue; // never link to self
      var res = ns.matcher.keywordScan({
        doc: doc, pageUrl: url, stems: kw.stems, targetKey: kw.targetKey, maxOccurrences: 3
      });
      if (res.alreadyLinked) { state.linked = (state.linked || 0) + 1; continue; }
      for (var j = 0; j < res.occurrences.length; j++) {
        var o = res.occurrences[j];
        state.rows.push([
          url, o.anchorText, kw.text, kw.targetUrl || '',
          kw.rank == null ? '' : kw.rank,
          kw.impressions == null ? '' : kw.impressions,
          o.position, o.relevance, o.contextSentence
        ]);
        found++;
      }
    }
    return found;
  }

  function processPage(url) {
    return fetchPage(url).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var n = state.mode === 'keywords' ? keywordsPage(url, doc) : opportunitiesPage(url, doc);
      state.done++;
      return n;
    }).catch(function (err) {
      state.failed++;
      if (state.errors.length < 50) {
        state.errors.push({ url: url, error: String(err && err.message || err) });
      }
      return 0;
    });
  }

  function step() {
    if (!running || stopRequested) {
      if (stopRequested) state.status = 'paused';
      running = false;
      return persist().then(report);
    }
    if (state.queue.length === 0) {
      state.status = 'done';
      running = false;
      return persist().then(function () { report({ finished: true }); });
    }
    var url = state.queue.shift();
    var started = Date.now();
    return processPage(url).then(function (found) {
      report({ url: url, found: found });
      if (++sincePersist >= PERSIST_EVERY) { sincePersist = 0; return persist(); }
    }).then(function () {
      var wait = Math.max(0, state.delayMs - (Date.now() - started));
      return new Promise(function (r) { setTimeout(r, wait); });
    }).then(step);
  }

  /* ------------------------------------------------------------------ *
   * Run setup
   * ------------------------------------------------------------------ */

  /** Load the index + crawl model and enrich targets, once per run. */
  function buildContext(origin, msg) {
    return Promise.all([get('ll_index:' + origin), get('ll_crawl:' + origin),
                        get('ll_gsc:' + origin)])
      .then(function (parts) {
        var index = parts[0], crawl = parts[1], gsc = parts[2];
        if (!index || !index.targets || index.targets.length === 0) {
          throw new Error('No site index yet — run a scan on the site first.');
        }
        var model = ns.intel.buildModel(crawl);
        ns.intel.enrich(index.targets, model, gsc);
        var c = { targets: index.targets, model: model, gsc: gsc, perTarget: {}, keywords: [] };

        if ((msg.mode || 'plan') === 'keywords') {
          var list = (msg.keywords || []).map(function (s) { return String(s).trim(); })
            .filter(Boolean);
          if (list.length === 0) throw new Error('Enter at least one keyword.');
          c.keywords = list.map(function (text) {
            var stems = tok.tokenizeText(text).filter(function (w) { return w.length >= 2; })
              .map(tok.stem);
            var target = null;
            if (msg.targetUrl) {
              target = { url: msg.targetUrl, siteKey: tok.siteKey(msg.targetUrl) };
            } else {
              var picked = ns.intel.pickTarget(index.targets, stems, gsc);
              if (picked) target = { url: picked.url, siteKey: picked.siteKey };
            }
            // Search Console, when connected, also tells us where this
            // keyword currently ranks — the reason to prioritise it.
            var evidence = gsc && ns.gsc ? ns.gsc.targetForQuery(gsc, stems) : null;
            return {
              text: text, stems: stems,
              targetKey: target ? target.siteKey : null,
              targetUrl: target ? target.url : null,
              rank: evidence ? evidence.position : null,
              impressions: evidence ? evidence.impressions : null
            };
          }).filter(function (k) { return k.stems.length > 0; });
          if (c.keywords.length === 0) throw new Error('Keywords contain no usable words.');
        }
        return c;
      });
  }

  function pageList(msg) {
    var mode = msg.mode || 'plan';
    if (mode === 'audit') return (msg.urls || []).slice(0, msg.limit || 500);
    // plan + keywords: the crawled set (real content pages), else the index
    var urls;
    if (ctx.model) {
      var crawled = {};
      Object.keys(ctx.model.pages).forEach(function (k) { crawled[k] = true; });
      urls = ctx.targets.filter(function (t) { return crawled[t.siteKey]; })
        .map(function (t) { return t.url; });
      if (urls.length === 0) urls = ctx.targets.map(function (t) { return t.url; });
    } else {
      urls = ctx.targets.map(function (t) { return t.url; });
    }
    return urls.slice(0, msg.limit || (mode === 'keywords' ? 2000 : 500));
  }

  function start(msg) {
    stopRequested = false;
    var mode = msg.mode || 'plan';
    return Promise.all([buildContext(msg.origin, msg), get(storageKey(mode, msg.origin))])
      .then(function (parts) {
        ctx = parts[0];
        var existing = parts[1];
        var resume = existing && existing.version === PLAN_VERSION &&
          existing.origin === msg.origin && !msg.fresh &&
          existing.queue && existing.queue.length > 0;

        if (resume) {
          state = existing;
          if (state.mode !== 'keywords') {
            // rebuild per-target counts so caps survive a resume
            for (var i = 0; i < state.rows.length; i++) {
              var k = tok.siteKey(state.rows[i][2]);
              ctx.perTarget[k] = (ctx.perTarget[k] || 0) + 1;
            }
          }
        } else {
          var urls = pageList(msg);
          var audit = mode === 'audit';
          state = {
            version: PLAN_VERSION,
            mode: mode,
            origin: msg.origin,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            status: 'running',
            total: urls.length,
            done: 0,
            failed: 0,
            linked: 0,
            delayMs: msg.delayMs || 1000,
            maxPerPage: audit ? 30 : (msg.maxPerPage || 3),
            // (a plain large number — Infinity does not survive storage)
            maxPerTarget: audit ? 1e9 : (msg.maxPerTarget || 5),
            minScore: audit ? 0 : (msg.minScore || 45),
            keywords: ctx.keywords.map(function (k) { return k.text; }),
            queue: urls,
            rows: [],
            errors: []
          };
        }
        state.status = 'running';
        if (msg.delayMs) state.delayMs = msg.delayMs;
        running = true;
        sincePersist = 0;
        // Persist before the first page so a panel that asks for status
        // right away (or reopens seconds later) sees the run, not nothing.
        return persist().then(function () {
          report({ started: true });
          step();
        });
      });
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.target !== 'll-offscreen') return;

    if (msg.type === 'LL_PLAN_START') {
      if (running) { sendResponse({ ok: false, error: 'Another background run is in progress — pause it first.' }); return; }
      sendResponse({ ok: true, accepted: true }); // sync ack; see crawler.js
      start(msg).catch(function (e) {
        var message = String(e && e.message || e);
        if (state) { state.status = 'error'; state.lastError = message; }
        chrome.runtime.sendMessage({
          type: 'LL_PLAN_PROGRESS', mode: msg.mode || 'plan', origin: msg.origin,
          status: 'error', done: 0, failed: 0, total: 0, links: 0, error: message
        }, function () { void chrome.runtime.lastError; });
      });
      return;
    }
    if (msg.type === 'LL_PLAN_STOP') {
      stopRequested = true;
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'LL_PLAN_PING') {
      sendResponse({ ok: true, running: running, mode: state ? state.mode : null });
      return;
    }
  });
})(self.__linkLens = self.__linkLens || {});
