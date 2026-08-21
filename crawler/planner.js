/**
 * Link Lens — crawler/planner.js  (runs in the offscreen document)
 *
 * Builds a SITE-WIDE internal linking plan: for every crawled page it
 * re-fetches the HTML, runs the full matcher against the enriched target
 * set, and records the best link opportunities. The result is the
 * deliverable an SEO actually hands a client — "add this link, on this
 * page, with this anchor, here's why".
 *
 * Why re-fetch instead of reusing the crawl: placing an anchor needs the
 * page's real sentences, and the crawl deliberately stores only the top
 * terms per page (full text for 2,000 pages would blow the storage
 * budget many times over). So this is opt-in, resumable, and polite.
 *
 * Editorial guardrails baked in:
 *  - at most N new links per page, and never more than 1 per ~200 words
 *  - at most M new links pointing at the same target (spread the equity)
 *  - only suggestions at or above a score floor
 *  - targets the page already links are excluded by the matcher itself
 */
(function (ns) {
  'use strict';

  var tok = ns.tokenizer;

  var PLAN_VERSION = 1;
  var PERSIST_EVERY = 6;
  var FETCH_TIMEOUT = 15000;

  var state = null;
  var running = false;
  var stopRequested = false;
  var sincePersist = 0;
  var ctx = null;      // { targets, model, perTarget: {} }

  function planKey(origin) { return 'll_plan:' + origin; }

  function get(key) {
    return chrome.storage.local.get(key).then(function (o) { return o[key] || null; });
  }

  function persist() {
    if (!state) return Promise.resolve();
    state.updatedAt = Date.now();
    var obj = {};
    obj[planKey(state.origin)] = state;
    return chrome.storage.local.set(obj).catch(function (e) {
      state.status = 'error';
      state.lastError = String(e && e.message || e);
      running = false;
    });
  }

  function report(extra) {
    var msg = {
      type: 'LL_PLAN_PROGRESS',
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

  /** How many new links this page can absorb without looking spammy. */
  function budgetFor(pageKey) {
    var page = ctx.model && ctx.model.pages[pageKey];
    var words = (page && page.w) || 0;
    var byLength = Math.max(1, Math.floor(words / 200));
    return Math.min(state.maxPerPage, byLength);
  }

  function planPage(url) {
    return fetchPage(url).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var result = ns.matcher.match({
        doc: doc,
        pageUrl: url,
        targets: ctx.targets,
        model: ctx.model
      });
      var pageKey = tok.siteKey(url);
      var budget = budgetFor(pageKey);
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
          url, s.anchorText, s.url, s.title || '',
          s.score == null ? '' : s.score,
          s.matchType, s.position || 'body',
          s.inbound == null ? '' : s.inbound,
          (s.reasons || []).join('; '),
          s.contextSentence
        ]);
      }
      state.done++;
      return taken;
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
    return planPage(url).then(function (found) {
      report({ url: url, found: found });
      if (++sincePersist >= PERSIST_EVERY) { sincePersist = 0; return persist(); }
    }).then(function () {
      var wait = Math.max(0, state.delayMs - (Date.now() - started));
      return new Promise(function (r) { setTimeout(r, wait); });
    }).then(step);
  }

  /** Load the index + crawl model and enrich targets, once per run. */
  function buildContext(origin) {
    return Promise.all([
      get('ll_index:' + origin),
      get('ll_crawl:' + origin)
    ]).then(function (parts) {
      var index = parts[0], crawl = parts[1];
      if (!index || !index.targets || index.targets.length === 0) {
        throw new Error('No site index yet — run a scan on the site first.');
      }
      var model = ns.intel.buildModel(crawl);
      ns.intel.enrich(index.targets, model);
      return { targets: index.targets, model: model, perTarget: {} };
    });
  }

  function start(msg) {
    stopRequested = false;
    return Promise.all([buildContext(msg.origin), get(planKey(msg.origin))])
      .then(function (parts) {
        ctx = parts[0];
        var existing = parts[1];
        var resume = existing && existing.version === PLAN_VERSION &&
          existing.origin === msg.origin && !msg.fresh &&
          existing.queue && existing.queue.length > 0;

        if (resume) {
          state = existing;
          // rebuild per-target counts so caps survive a resume
          for (var i = 0; i < state.rows.length; i++) {
            var k = tok.siteKey(state.rows[i][2]);
            ctx.perTarget[k] = (ctx.perTarget[k] || 0) + 1;
          }
        } else {
          // Plan the pages we know are real content: the crawled set,
          // falling back to the index when no crawl exists.
          var urls;
          if (ctx.model) {
            var crawled = {};
            Object.keys(ctx.model.pages).forEach(function (k) { crawled[k] = true; });
            urls = ctx.targets.filter(function (t) { return crawled[t.siteKey]; })
              .map(function (t) { return t.url; });
          } else {
            urls = ctx.targets.map(function (t) { return t.url; });
          }
          urls = urls.slice(0, msg.limit || 500);
          state = {
            version: PLAN_VERSION,
            origin: msg.origin,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            status: 'running',
            total: urls.length,
            done: 0,
            failed: 0,
            delayMs: msg.delayMs || 1000,
            maxPerPage: msg.maxPerPage || 3,
            maxPerTarget: msg.maxPerTarget || 5,
            minScore: msg.minScore || 45,
            queue: urls,
            rows: [],
            errors: []
          };
        }
        state.status = 'running';
        if (msg.delayMs) state.delayMs = msg.delayMs;
        running = true;
        sincePersist = 0;
        report({ started: true });
        step();
        return { ok: true, total: state.total, resumed: !!resume };
      });
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.target !== 'll-offscreen') return;

    if (msg.type === 'LL_PLAN_START') {
      if (running) { sendResponse({ ok: false, error: 'A plan run is already going.' }); return; }
      start(msg).then(sendResponse, function (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      });
      return true;
    }
    if (msg.type === 'LL_PLAN_STOP') {
      stopRequested = true;
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'LL_PLAN_PING') {
      sendResponse({ ok: true, running: running });
      return;
    }
  });
})(self.__linkLens = self.__linkLens || {});
