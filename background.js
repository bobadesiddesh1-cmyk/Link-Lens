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

importScripts('shared/tokenizer.js', 'shared/gsc.js');

try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} catch (e) { /* very old Chrome: icon click does nothing */ }

function bulkKey(origin) { return 'll_bulk:' + origin; }
function crawlKey(origin) { return 'll_crawl:' + origin; }
function gscKey(origin) { return 'll_gsc:' + origin; }
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
 * Google Search Console
 *
 * OAuth runs through chrome.identity, so no token ever passes through a
 * server of ours (there is no server). The access token stays in
 * Chrome's own token cache; only the aggregated query→page model is
 * written to local storage, per origin, and it never leaves the browser.
 * ------------------------------------------------------------------ */

var GSC_API = 'https://www.googleapis.com/webmasters/v3';
var GSC_ORIGIN_PERMISSION = { origins: ['https://www.googleapis.com/*'] };
var GSC_DAYS = 90;
var GSC_ROWS_PER_CALL = 25000;
var GSC_MAX_CALLS = 4; // rows arrive click-desc, so the head is what matters

function ll_gscToken(interactive) {
  return new Promise(function (resolve, reject) {
    if (!chrome.identity || !chrome.identity.getAuthToken) {
      reject(new Error('Google sign-in needs Chrome — this browser does not support it.'));
      return;
    }
    // A throw inside the callback would strand this promise forever, so
    // every path below settles it explicitly.
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error('Google sign-in did not respond. Check that you are signed in to Chrome.'));
    }, 120000);
    try {
      chrome.identity.getAuthToken({ interactive: !!interactive }, function (token) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        var err = chrome.runtime.lastError;
        if (err || !token) {
          reject(new Error((err && err.message) || 'not signed in'));
          return;
        }
        resolve(typeof token === 'string' ? token : token.token);
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

/**
 * Can we reach googleapis.com? The permission is optional and must be
 * REQUESTED from the side panel, synchronously inside the click that
 * asks for it — chrome.permissions.request needs a user gesture, and a
 * service worker never has one. Here we only check.
 */
function ll_gscHostPermission() {
  return new Promise(function (resolve) {
    try {
      chrome.permissions.contains(GSC_ORIGIN_PERMISSION, function (has) {
        void chrome.runtime.lastError;
        resolve(!!has);
      });
    } catch (e) { resolve(false); }
  });
}

function ll_gscFetch(token, path, body) {
  var opts = {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token }
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(GSC_API + path, opts).then(function (res) {
    if (res.status === 401 || res.status === 403) {
      return res.text().then(function (t) {
        var e = new Error(/insufficient|scope/i.test(t)
          ? 'Google did not grant Search Console access — disconnect and try again.'
          : 'Google rejected the request (' + res.status + '). Reconnect Search Console.');
        e.authFailure = true;
        throw e;
      });
    }
    if (!res.ok) {
      return res.text().then(function (t) {
        throw new Error('Search Console API error ' + res.status + ': ' + t.slice(0, 200));
      });
    }
    return res.json();
  });
}

/** Retry once with a fresh token: cached tokens expire after an hour. */
function ll_gscCall(path, body) {
  return ll_gscToken(false).then(function (token) {
    return ll_gscFetch(token, path, body).catch(function (err) {
      if (!err.authFailure) throw err;
      return new Promise(function (resolve) {
        chrome.identity.removeCachedAuthToken({ token: token }, resolve);
      }).then(function () {
        return ll_gscToken(true).then(function (fresh) {
          return ll_gscFetch(fresh, path, body);
        });
      });
    });
  });
}

function ll_gscDateRange() {
  // Search Console data lags ~2 days; asking for today returns nothing.
  var end = new Date(Date.now() - 2 * 86400000);
  var start = new Date(end.getTime() - GSC_DAYS * 86400000);
  var iso = function (d) { return d.toISOString().slice(0, 10); };
  return { startDate: iso(start), endDate: iso(end) };
}

function ll_gscProgress(origin, status, extra) {
  var msg = { type: 'LL_GSC_PROGRESS', origin: origin, status: status };
  if (extra) Object.assign(msg, extra);
  chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; });
}

/** Pull query x page rows and fold them into the stored model. */
function ll_gscSync(origin, property) {
  var range = ll_gscDateRange();
  var rows = [];
  var path = '/sites/' + encodeURIComponent(property) + '/searchAnalytics/query';

  function pull(call) {
    if (call >= GSC_MAX_CALLS) return Promise.resolve();
    ll_gscProgress(origin, 'running', { rows: rows.length, call: call + 1 });
    return ll_gscCall(path, {
      startDate: range.startDate,
      endDate: range.endDate,
      dimensions: ['page', 'query'],
      rowLimit: GSC_ROWS_PER_CALL,
      startRow: call * GSC_ROWS_PER_CALL,
      dataState: 'final'
    }).then(function (res) {
      var batch = (res && res.rows) || [];
      rows = rows.concat(batch);
      if (batch.length < GSC_ROWS_PER_CALL) return; // last page
      return pull(call + 1);
    });
  }

  return pull(0).then(function () {
    var model = self.__linkLens.gsc.buildModel(rows, {
      property: property, startDate: range.startDate, endDate: range.endDate
    });
    var obj = {};
    obj[gscKey(origin)] = model;
    return chrome.storage.local.set(obj).then(function () {
      ll_gscProgress(origin, 'done', {
        pages: model.totals.pages, clicks: model.totals.clicks,
        impressions: model.totals.impressions, rows: model.totals.rows
      });
      return model;
    });
  });
}

function ll_gscSummary(model) {
  if (!model) return null;
  return {
    property: model.property,
    label: self.__linkLens.gsc.propertyLabel(model.property),
    updatedAt: model.updatedAt,
    startDate: model.startDate,
    endDate: model.endDate,
    totals: model.totals
  };
}

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

    /* ---- Search Console ---- */

    case 'LL_GSC_STATUS':
      chrome.storage.local.get(gscKey(msg.origin)).then(function (obj) {
        sendResponse({ ok: true, gsc: ll_gscSummary(obj[gscKey(msg.origin)] || null) });
      });
      return true;

    case 'LL_GSC_LIST':
      // Sign in and report every property this account can read, marking
      // the one that covers the current site. Choosing is the user's call:
      // a site can legitimately sit under a domain property, a URL-prefix
      // property, or a www variant of either.
      ll_gscHostPermission().then(function (granted) {
        if (!granted) {
          throw new Error('Access to googleapis.com was not granted — click Connect again and choose Allow.');
        }
        return ll_gscToken(true);
      }).then(function (token) {
        return ll_gscFetch(token, '/sites');
      }).then(function (res) {
        var list = ((res && res.siteEntry) || []).filter(function (p) {
          return p.permissionLevel !== 'siteUnverifiedUser';
        });
        sendResponse({
          ok: true,
          properties: list.map(function (p) {
            return { siteUrl: p.siteUrl, permissionLevel: p.permissionLevel,
                     label: self.__linkLens.gsc.propertyLabel(p.siteUrl) };
          }),
          suggested: self.__linkLens.gsc.matchProperty(list, msg.origin)
        });
      }).catch(function (err) {
        var m = String(err && err.message || err);
        sendResponse({ ok: false, error: /not signed in|canceled|cancelled/i.test(m)
          ? 'Google sign-in was cancelled.' : m });
      });
      return true;

    case 'LL_GSC_CONNECT':
      ll_gscHostPermission().then(function (granted) {
        if (!granted) {
          throw new Error('Access to googleapis.com was not granted — click Connect again and choose Allow.');
        }
        return ll_gscToken(true);
      }).then(function (token) {
        return ll_gscFetch(token, '/sites');
      }).then(function (res) {
        var list = (res && res.siteEntry) || [];
        var property = msg.property ||
          self.__linkLens.gsc.matchProperty(list, msg.origin);
        if (!property) {
          sendResponse({
            ok: false,
            noProperty: true,
            error: 'None of your Search Console properties cover ' +
              msg.origin + '. Add and verify it in Search Console first.',
            properties: list.map(function (p) { return p.siteUrl; })
          });
          return null;
        }
        return ll_gscSync(msg.origin, property).then(function (model) {
          sendResponse({ ok: true, gsc: ll_gscSummary(model),
            properties: list.map(function (p) { return p.siteUrl; }) });
        });
      }).catch(function (err) {
        var m = String(err && err.message || err);
        ll_gscProgress(msg.origin, 'error', { error: m });
        sendResponse({ ok: false, error: /not signed in|canceled|cancelled/i.test(m)
          ? 'Google sign-in was cancelled.' : m });
      });
      return true;

    case 'LL_GSC_SYNC':
      chrome.storage.local.get(gscKey(msg.origin)).then(function (obj) {
        var stored = obj[gscKey(msg.origin)];
        var property = msg.property || (stored && stored.property);
        if (!property) throw new Error('Connect Search Console first.');
        return ll_gscSync(msg.origin, property).then(function (model) {
          sendResponse({ ok: true, gsc: ll_gscSummary(model) });
        });
      }).catch(function (err) {
        var m = String(err && err.message || err);
        ll_gscProgress(msg.origin, 'error', { error: m });
        sendResponse({ ok: false, error: m });
      });
      return true;

    case 'LL_GSC_DISCONNECT':
      // Drop the stored data first, then hand the token back to Google so
      // the grant is genuinely revoked rather than just forgotten locally.
      chrome.storage.local.remove(gscKey(msg.origin)).then(function () {
        return ll_gscToken(false).catch(function () { return null; });
      }).then(function (token) {
        if (!token) return;
        return fetch('https://accounts.google.com/o/oauth2/revoke?token=' + token)
          .catch(function () { /* offline: the local cache is still cleared */ })
          .then(function () {
            return new Promise(function (r) {
              chrome.identity.removeCachedAuthToken({ token: token }, r);
            });
          });
      }).then(function () {
        sendResponse({ ok: true });
      });
      return true;
  }
});
