/**
 * Link Lens — background.js (MV3 service worker)
 *
 * The heavy lifting (sitemap fetch, matching, bulk fetches) happens in the
 * content-script context of the active tab so every request is same-origin
 * (no host permissions needed). The service worker's job is durability:
 * it listens to bulk-mode progress coming from tabs and persists the run
 * state per origin, so the popup can be closed and reopened mid-batch
 * without losing progress or the finished CSV rows.
 *
 * Messages handled (from content scripts):
 *   LL_BULK_PROGRESS {done, total, url, ok, error?, found?}
 *   LL_BULK_DONE     {rows, failures, total, cancelled}
 * Messages handled (from the popup):
 *   LL_GET_BULK  {origin}  → last persisted bulk state for that origin
 *   LL_CLEAR_BULK {origin} → forget a finished run
 */
'use strict';

function bulkKey(origin) { return 'll_bulk:' + origin; }

function originFromSender(sender) {
  try {
    if (sender && sender.tab && sender.tab.url) return new URL(sender.tab.url).origin;
    if (sender && sender.origin) return sender.origin;
  } catch (e) { /* fall through */ }
  return null;
}

function getState(origin) {
  return chrome.storage.local.get(bulkKey(origin)).then(function (obj) {
    return obj[bulkKey(origin)] || null;
  });
}

function setState(origin, state) {
  state.updatedAt = Date.now();
  var obj = {};
  obj[bulkKey(origin)] = state;
  return chrome.storage.local.set(obj);
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'LL_BULK_PROGRESS': {
      var origin = originFromSender(sender);
      if (!origin) return;
      getState(origin).then(function (state) {
        state = state || { status: 'running', progress: [], rows: [], failures: [] };
        state.status = 'running';
        state.done = msg.done;
        state.total = msg.total;
        state.progress.push({
          url: msg.url, ok: msg.ok,
          error: msg.error || null,
          found: msg.found || 0
        });
        return setState(origin, state);
      });
      return; // fire-and-forget
    }

    case 'LL_BULK_DONE': {
      var doneOrigin = originFromSender(sender);
      if (!doneOrigin) return;
      getState(doneOrigin).then(function (state) {
        state = state || { progress: [] };
        state.status = msg.cancelled ? 'cancelled' : 'done';
        state.rows = msg.rows || [];
        state.failures = msg.failures || [];
        state.total = msg.total;
        state.done = msg.total;
        return setState(doneOrigin, state);
      });
      return;
    }

    case 'LL_GET_BULK':
      getState(msg.origin).then(function (state) {
        sendResponse({ ok: true, state: state });
      });
      return true; // async response

    case 'LL_CLEAR_BULK':
      chrome.storage.local.remove(bulkKey(msg.origin)).then(function () {
        sendResponse({ ok: true });
      });
      return true;
  }
});
