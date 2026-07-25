/**
 * Link Lens — content/main.js
 * In-tab orchestrator. Receives commands from the popup, drives
 * index build → match → highlight → panel, and runs bulk mode
 * (same-origin fetch + DOMParser, off-DOM matching) with progress
 * streamed to the runtime (popup + background).
 *
 * Message contract (see DECISIONS.md):
 *   in : LL_PING | LL_STATUS | LL_SCAN {force} | LL_REBUILD | LL_CLEAR |
 *        LL_BULK_START {urls} | LL_BULK_CANCEL
 *   out: LL_PROGRESS {stage, message} | LL_SCAN_DONE {summary} |
 *        LL_BULK_PROGRESS {done,total,url,ok,error,found} |
 *        LL_BULK_DONE {rows, failures}
 */
(function (ns) {
  'use strict';
  if (self.__linkLensInjected) return; // idempotent injection
  self.__linkLensInjected = true;

  var ORIGIN = location.origin;
  var lastScan = null;      // { suggestions, alreadyLinked, capped, indexInfo }
  var bulkCancelled = false;
  var bulkRunning = false;

  /* ------------------------------------------------------------------ */

  function broadcast(msg) {
    try {
      chrome.runtime.sendMessage(msg, function () {
        void chrome.runtime.lastError; // popup may be closed — fine
      });
    } catch (e) { /* extension context gone; nothing to do */ }
  }

  function progress(stage, message) {
    broadcast({ type: 'LL_PROGRESS', stage: stage, message: message });
  }

  /* ------------------------------------------------------------------ *
   * Index
   * ------------------------------------------------------------------ */

  function getIndex(force) {
    if (force) return buildIndex();
    return ns.storage.getIndex(ORIGIN).then(function (cached) {
      if (cached) {
        progress('index', 'Using cached site index (' + cached.targets.length + ' targets).');
        return cached;
      }
      return buildIndex();
    });
  }

  function buildIndex() {
    progress('index', 'Building site index — fetching sitemap…');
    return ns.indexer.build(ORIGIN, document, function (msg) {
      progress('index', msg);
    }).then(function (index) {
      return ns.storage.setIndex(ORIGIN, index).then(function () {
        progress('index', 'Index ready: ' + index.targets.length + ' link targets' +
          (index.shallow ? ' (shallow mode)' : '') + '.');
        return index;
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Scan current page
   * ------------------------------------------------------------------ */

  function onHighlightClick(id) {
    var s = lastScan && lastScan.suggestions[id];
    if (!s) return;
    var span = ns.highlighter.getSpan(id);
    if (span) ns.card.show(s, span);
  }

  function renderPanel() {
    ns.panel.render(document, {
      suggestions: lastScan.suggestions,
      alreadyLinked: lastScan.alreadyLinked,
      capped: lastScan.capped,
      indexInfo: lastScan.indexInfo,
      diagnosis: lastScan.diagnosis || null,
      pageUrl: location.href
    }, {
      onFocus: function (id) {
        ns.card.hide();
        ns.highlighter.focusSuggestion(id);
      },
      onClear: clearAll,
      onExport: exportCsv
    });
  }

  function exportCsv() {
    if (!lastScan) return;
    var rows = lastScan.suggestions.map(function (s) {
      return [location.href, s.anchorText, s.url, s.matchType, s.contextSentence];
    });
    var csv = ns.csv.build(
      ['source_url', 'anchor_text', 'target_url', 'match_type', 'context_sentence'],
      rows
    );
    ns.csv.download('link-lens-' + location.hostname + '.csv', csv, document);
  }

  function clearAll() {
    ns.highlighter.clear();
    ns.card.destroy();
    ns.panel.destroy();
    lastScan = null;
  }

  function scan(force) {
    // Restore the DOM before matching so a re-scan sees the original text,
    // not our own highlight spans.
    ns.highlighter.clear();
    ns.card.hide();
    return getIndex(force).then(function (index) {
      progress('match', 'Scanning page copy against ' + index.targets.length + ' targets…');
      var t0 = performance.now();
      var result = ns.matcher.match({
        doc: document,
        pageUrl: location.href,
        targets: index.targets
      });
      var elapsed = Math.round(performance.now() - t0);

      lastScan = {
        suggestions: result.suggestions,
        alreadyLinked: result.alreadyLinked,
        capped: result.capped,
        indexInfo: {
          shallow: index.shallow,
          skippedGz: index.skippedGz,
          capped: index.capped,
          source: index.source,
          builtAt: index.builtAt,
          targetCount: index.targets.length
        }
      };

      ns.highlighter.apply(result.suggestions, result.words, onHighlightClick);
      renderPanel();

      // When a scan finds nothing, say WHY — a bare zero looks broken.
      var diagnosis = null;
      if (result.suggestions.length === 0) {
        if (result.wordCount === 0) {
          diagnosis = 'Could not extract readable text from this page (unusual page structure). Try another page of this site — and please report this page.';
        } else if (index.targets.length === 0) {
          diagnosis = 'The site index has no usable link targets — the sitemap URLs did not yield keyword slugs.';
        } else if (result.alreadyLinked.length > 0) {
          diagnosis = 'No new opportunities: this page already links ' + result.alreadyLinked.length +
            ' of the matching targets, and no other target phrases appear in its copy (' + result.wordCount + ' words scanned).';
        } else {
          diagnosis = 'None of the ' + index.targets.length + ' target phrases appear in this page\'s copy (' +
            result.wordCount + ' words scanned). Longer articles surface more opportunities.';
        }
      }

      var summary = {
        suggestions: result.suggestions.length,
        alreadyLinked: result.alreadyLinked.length,
        wordCount: result.wordCount,
        elapsedMs: elapsed,
        shallow: index.shallow,
        targetCount: index.targets.length,
        source: index.source,
        diagnosis: diagnosis
      };
      lastScan.diagnosis = diagnosis;
      broadcast({ type: 'LL_SCAN_DONE', summary: summary });
      return summary;
    });
  }

  /* ------------------------------------------------------------------ *
   * Bulk mode — fetch + match off-DOM, 1 request/second
   * ------------------------------------------------------------------ */

  function fetchHtml(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    return fetch(url, { credentials: 'include', redirect: 'follow', signal: controller.signal })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct && ct.indexOf('html') === -1) throw new Error('not HTML (' + ct.split(';')[0] + ')');
        return res.text();
      }, function (err) {
        clearTimeout(timer);
        throw (err && err.name === 'AbortError') ? new Error('timeout') : err;
      });
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function runBulk(urls) {
    bulkCancelled = false;
    bulkRunning = true;
    var rows = [];       // combined CSV rows
    var failures = [];   // [{url, error}]
    var total = urls.length;

    return getIndex(false).then(function (index) {
      var chain = Promise.resolve();
      urls.forEach(function (url, i) {
        chain = chain.then(function () {
          if (bulkCancelled) return;
          var started = Date.now();
          return fetchHtml(url).then(function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var result = ns.matcher.match({ doc: doc, pageUrl: url, targets: index.targets });
            result.suggestions.forEach(function (s) {
              rows.push([url, s.anchorText, s.url, s.matchType, s.contextSentence]);
            });
            broadcast({
              type: 'LL_BULK_PROGRESS',
              done: i + 1, total: total, url: url, ok: true,
              found: result.suggestions.length
            });
          }).catch(function (err) {
            failures.push({ url: url, error: String(err && err.message || err) });
            broadcast({
              type: 'LL_BULK_PROGRESS',
              done: i + 1, total: total, url: url, ok: false,
              error: String(err && err.message || err)
            });
          }).then(function () {
            // Rate limit: ≥1000ms between request STARTS (skip after last).
            if (i < total - 1 && !bulkCancelled) {
              var wait = 1000 - (Date.now() - started);
              if (wait > 0) return delay(wait);
            }
          });
        });
      });
      return chain.then(function () {
        bulkRunning = false;
        var payload = {
          type: 'LL_BULK_DONE',
          cancelled: bulkCancelled,
          rows: rows,
          failures: failures,
          total: total
        };
        broadcast(payload);
        return payload;
      });
    }).catch(function (err) {
      bulkRunning = false;
      var payload = {
        type: 'LL_BULK_DONE',
        cancelled: false,
        rows: rows,
        failures: [{ url: '(index)', error: String(err && err.message || err) }],
        total: total
      };
      broadcast(payload);
      return payload;
    });
  }

  /* ------------------------------------------------------------------ *
   * Command listener
   * ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'LL_PING':
        sendResponse({ ok: true, origin: ORIGIN });
        return;

      case 'LL_STATUS':
        ns.storage.getIndex(ORIGIN).then(function (cached) {
          sendResponse({
            ok: true,
            origin: ORIGIN,
            url: location.href,
            indexCached: !!cached,
            builtAt: cached ? cached.builtAt : null,
            targetCount: cached ? cached.targets.length : 0,
            shallow: cached ? cached.shallow : false,
            source: cached ? cached.source : null,
            highlightsActive: ns.highlighter.isActive(),
            bulkRunning: bulkRunning
          });
        });
        return true; // async

      case 'LL_SCAN':
        scan(!!msg.force).then(function (summary) {
          sendResponse({ ok: true, summary: summary });
        }).catch(function (err) {
          sendResponse({ ok: false, error: String(err && err.message || err) });
        });
        return true;

      case 'LL_REBUILD':
        ns.storage.clearIndex(ORIGIN).then(function () {
          return scan(true);
        }).then(function (summary) {
          sendResponse({ ok: true, summary: summary });
        }).catch(function (err) {
          sendResponse({ ok: false, error: String(err && err.message || err) });
        });
        return true;

      case 'LL_CLEAR':
        clearAll();
        sendResponse({ ok: true });
        return;

      case 'LL_BULK_START':
        if (bulkRunning) {
          sendResponse({ ok: false, error: 'A bulk run is already in progress.' });
          return;
        }
        runBulk(msg.urls || []);
        sendResponse({ ok: true, started: true, total: (msg.urls || []).length });
        return;

      case 'LL_BULK_CANCEL':
        bulkCancelled = true;
        sendResponse({ ok: true });
        return;
    }
  });
})(self.__linkLens = self.__linkLens || {});
