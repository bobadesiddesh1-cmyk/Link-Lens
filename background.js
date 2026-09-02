/**
 * Link Lens — background.js (MV3 service worker)
 *
 * Two jobs:
 *  1. Open the side panel when the toolbar icon is clicked.
 *  2. Own the site crawl: the heavy work runs in an offscreen document
 *     (service workers have no DOMParser), and this worker starts it,
 *     relays commands, persists nothing itself, and keeps a watchdog
 *     alarm so an interrupted crawl resumes automatically.
 *
 * Bulk/keyword runs still stream from the tab's content script; their
 * progress is buffered here so the side panel can close and reopen.
 */
'use strict';

try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} catch (e) { /* very old Chrome: icon click does nothing */ }

function bulkKey(origin) { return 'll_bulk:' + origin; }
function crawlKey(origin) { return 'll_crawl:' + origin; }
var PLAN_PREFIX = { plan: 'll_plan:', audit: 'll_audit:', keywords: 'll_kwsite:' };
function planKey(mode, origin) { return (PLAN_PREFIX[mode] || PLAN_PREFIX.plan) + origin; }

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

/* ------------------------------------------------------------------ *
 * Offscreen crawler lifecycle
 * ------------------------------------------------------------------ */

var creatingOffscreen = null;

function ensureOffscreen() {
  return chrome.offscreen.hasDocument().then(function (has) {
    if (has) return true;
    if (!creatingOffscreen) {
      creatingOffscreen = chrome.offscreen.createDocument({
        url: 'crawler/offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Parse fetched pages of the user\'s own site to build the internal-link index.'
      }).catch(function (e) {
        // A concurrent create can race; treat "already exists" as success.
        if (!/already/i.test(String(e && e.message))) throw e;
      }).then(function () {
        creatingOffscreen = null;
        return true;
      });
    }
    return creatingOffscreen;
  });
}

function sendOnce(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(msg, function (res) {
      void chrome.runtime.lastError;
      resolve(res || null);
    });
  });
}

/**
 * Message the offscreen worker, retrying briefly: a freshly created
 * offscreen document exists before its scripts have registered their
 * message listeners, so the first send can land in a gap.
 */
function toOffscreen(msg, attempt) {
  attempt = attempt || 0;
  return ensureOffscreen().then(function () {
    msg.target = 'll-offscreen';
    return sendOnce(msg);
  }).then(function (res) {
    if (res) return res;
    if (attempt >= 6) return { ok: false, error: 'crawler did not respond' };
    return new Promise(function (r) { setTimeout(r, 250); })
      .then(function () { return toOffscreen(msg, attempt + 1); });
  });
}

/** Resume a crawl that was interrupted (worker restart, browser restart). */
function resumeIfNeeded() {
  return chrome.storage.local.get(null).then(function (all) {
    var keys = Object.keys(all).filter(function (k) { return k.indexOf('ll_crawl:') === 0; });
    var pending = keys.map(function (k) { return all[k]; }).filter(function (c) {
      return c && c.status === 'running' && c.queue && c.queue.length > 0;
    });
    if (pending.length === 0) return;
    return toOffscreen({ type: 'LL_CRAWL_PING' }).then(function (res) {
      if (res && res.running) return; // already going
      var c = pending[0];
      return toOffscreen({
        type: 'LL_CRAWL_START', origin: c.origin, delayMs: c.delayMs
      });
    });
  });
}

chrome.alarms.create('ll-crawl-watchdog', { periodInMinutes: 1 });
function resumePlanIfNeeded() {
  return chrome.storage.local.get(null).then(function (all) {
    var pending = Object.keys(all)
      .filter(function (k) { return /^ll_(plan|audit|kwsite):/.test(k); })
      .map(function (k) { return all[k]; })
      .filter(function (p) { return p && p.status === 'running' && p.queue && p.queue.length; });
    if (!pending.length) return;
    return toOffscreen({ type: 'LL_PLAN_PING' }).then(function (res) {
      if (res && res.running) return;
      var p = pending[0];
      return toOffscreen({ type: 'LL_PLAN_START', mode: p.mode || 'plan', origin: p.origin,
        delayMs: p.delayMs, keywords: p.keywords, urls: p.queue });
    });
  });
}

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'll-crawl-watchdog') { resumeIfNeeded(); resumePlanIfNeeded(); }
});
chrome.runtime.onStartup.addListener(resumeIfNeeded);

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.target === 'll-offscreen') return; // not ours

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
      return;
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
      return true;

    case 'LL_CLEAR_BULK':
      chrome.storage.local.remove(bulkKey(msg.origin)).then(function () {
        sendResponse({ ok: true });
      });
      return true;

    /* ---- crawl control (from the side panel) ---- */

    case 'LL_CRAWL_START':
      toOffscreen({
        type: 'LL_CRAWL_START',
        origin: msg.origin,
        urls: msg.urls,
        limit: msg.limit,
        delayMs: msg.delayMs,
        fresh: msg.fresh
      }).then(sendResponse);
      return true;

    case 'LL_CRAWL_STOP':
      toOffscreen({ type: 'LL_CRAWL_STOP' }).then(sendResponse);
      return true;

    case 'LL_CRAWL_STATUS':
      chrome.storage.local.get(crawlKey(msg.origin)).then(function (obj) {
        var c = obj[crawlKey(msg.origin)] || null;
        sendResponse({
          ok: true,
          crawl: c ? {
            status: c.status, done: c.done, failed: c.failed, total: c.total,
            pages: Object.keys(c.pages || {}).length, updatedAt: c.updatedAt,
            remaining: (c.queue || []).length, lastError: c.lastError || null,
            errors: (c.errors || []).slice(0, 10)
          } : null
        });
      });
      return true;

    case 'LL_PLAN_START':
      toOffscreen({
        type: 'LL_PLAN_START', mode: msg.mode || 'plan', origin: msg.origin,
        limit: msg.limit, delayMs: msg.delayMs, maxPerPage: msg.maxPerPage,
        maxPerTarget: msg.maxPerTarget, minScore: msg.minScore, fresh: msg.fresh,
        urls: msg.urls, keywords: msg.keywords, targetUrl: msg.targetUrl
      }).then(sendResponse);
      return true;

    case 'LL_PLAN_STOP':
      toOffscreen({ type: 'LL_PLAN_STOP' }).then(sendResponse);
      return true;

    case 'LL_PLAN_STATUS':
      chrome.storage.local.get(planKey(msg.mode, msg.origin)).then(function (obj) {
        var p = obj[planKey(msg.mode, msg.origin)] || null;
        sendResponse({
          ok: true,
          plan: p ? {
            mode: p.mode, status: p.status, done: p.done, failed: p.failed, total: p.total,
            linked: p.linked || 0, links: (p.rows || []).length,
            remaining: (p.queue || []).length, updatedAt: p.updatedAt,
            lastError: p.lastError || null, keywords: p.keywords || []
          } : null
        });
      });
      return true;

    case 'LL_PLAN_ROWS':
      chrome.storage.local.get(planKey(msg.mode, msg.origin)).then(function (obj) {
        var p = obj[planKey(msg.mode, msg.origin)] || null;
        sendResponse({ ok: true, rows: p ? p.rows : [], mode: p ? p.mode : null });
      });
      return true;

    case 'LL_PLAN_CLEAR':
      chrome.storage.local.remove(planKey(msg.mode, msg.origin)).then(function () {
        sendResponse({ ok: true });
      });
      return true;

    case 'LL_CRAWL_CLEAR':
      chrome.storage.local.remove(crawlKey(msg.origin)).then(function () {
        sendResponse({ ok: true });
      });
      return true;
  }
});
