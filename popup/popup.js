/**
 * Link Lens — popup/popup.js
 * Scan tab: injects the content-script bundle into the active tab
 * (activeTab + scripting) and drives LL_SCAN / LL_REBUILD / LL_CLEAR.
 * Bulk tab: validates up to 20 same-domain URLs, starts LL_BULK_START in
 * the tab, renders streamed progress, and builds the combined CSV.
 */
'use strict';

var ns = self.__linkLens; // tokenizer + csv, loaded by popup.html

var CONTENT_FILES = [
  'shared/tokenizer.js',
  'shared/storage.js',
  'shared/csv.js',
  'content/sitemap.js',
  'content/indexer.js',
  'content/matcher.js',
  'content/highlighter.js',
  'content/card.js',
  'content/panel.js',
  'content/main.js'
];

var tab = null;         // active tab
var origin = null;      // its origin
var bulkRows = null;    // finished bulk rows for CSV download
var lastSummary = null; // last scan summary, for the debug-info copy

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function $(id) { return document.getElementById(id); }

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function sendToTab(msg) {
  return new Promise(function (resolve, reject) {
    chrome.tabs.sendMessage(tab.id, msg, function (res) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function sendToBackground(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(msg, function (res) {
      void chrome.runtime.lastError;
      resolve(res);
    });
  });
}

/** Inject the content bundle once; a live LL_PING short-circuits. */
function ensureInjected() {
  return sendToTab({ type: 'LL_PING' }).catch(function () {
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: CONTENT_FILES
    }).then(function () {
      return sendToTab({ type: 'LL_PING' });
    });
  });
}

function fail(el, message) {
  el.textContent = message;
  show(el);
}

function timeAgo(ts) {
  var mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  var hrs = Math.round(mins / 60);
  return hrs + ' h ago';
}

/* ------------------------------------------------------------------ *
 * Scan tab
 * ------------------------------------------------------------------ */

function refreshCacheStatus() {
  var key = 'll_index:' + origin;
  chrome.storage.local.get(key, function (obj) {
    var entry = obj[key];
    var dot = $('cache-dot');
    var fresh = entry && entry.builtAt &&
      (Date.now() - entry.builtAt) < 24 * 60 * 60 * 1000;
    if (fresh) {
      dot.className = 'dot fresh';
      $('cache-text').textContent = 'Site index cached — ' +
        entry.targets.length + ' targets';
      $('cache-sub').textContent =
        (entry.shallow ? 'Shallow mode (no sitemap). ' : '') +
        'Built ' + timeAgo(entry.builtAt) + ' · source: ' + (entry.source || 'sitemap');
    } else {
      dot.className = 'dot stale';
      $('cache-text').textContent = 'No site index cached for ' + new URL(origin).hostname;
      $('cache-sub').textContent = 'First scan will fetch the sitemap and build it (cached 24 h).';
    }
  });
}

function setScanBusy(busy) {
  $('btn-scan').disabled = busy;
  $('btn-rebuild').disabled = busy;
}

function runScan(msgType) {
  hide($('scan-error'));
  hide($('scan-result'));
  setScanBusy(true);
  var prog = $('scan-progress');
  prog.innerHTML = '<span class="spin">◌</span> Starting…';
  show(prog);

  ensureInjected().then(function () {
    return sendToTab({ type: msgType, force: false });
  }).then(function (res) {
    setScanBusy(false);
    hide(prog);
    if (!res || !res.ok) {
      fail($('scan-error'), (res && res.error) || 'Scan failed — try reloading the page.');
      return;
    }
    var s = res.summary;
    $('result-count').textContent = s.suggestions;
    $('result-label').textContent =
      s.suggestions === 1 ? 'opportunity highlighted on the page'
        : 'opportunities highlighted on the page';
    $('result-sub').textContent =
      s.alreadyLinked + ' already linked · ' + s.targetCount + ' targets' +
      (s.shallow ? ' (shallow mode)' : '') +
      ' · matched ' + s.wordCount + ' words in ' + s.elapsedMs + ' ms';
    if (s.diagnosis) {
      $('result-diagnosis').textContent = s.diagnosis;
      show($('result-diagnosis'));
      lastSummary = s;
      show($('btn-debug'));
    } else {
      hide($('result-diagnosis'));
      hide($('btn-debug'));
    }
    show($('scan-result'));
    refreshCacheStatus();
  }).catch(function (err) {
    setScanBusy(false);
    hide(prog);
    fail($('scan-error'), 'Could not run on this page: ' + err.message);
  });
}

/* ------------------------------------------------------------------ *
 * Bulk tab
 * ------------------------------------------------------------------ */

function parseBulkUrls(raw) {
  var lines = raw.split(/\r?\n/).map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 0; });
  if (lines.length === 0) throw new Error('Paste at least one URL.');
  if (lines.length > 20) throw new Error('Maximum 20 URLs per batch (you pasted ' + lines.length + ').');
  var seen = new Set();
  var urls = [];
  for (var i = 0; i < lines.length; i++) {
    var u;
    try { u = new URL(lines[i]); }
    catch (e) { throw new Error('Not a valid URL: "' + lines[i] + '"'); }
    if (u.origin !== origin) {
      throw new Error('Off-domain URL (must be on ' + new URL(origin).hostname + '): ' + lines[i]);
    }
    if (!seen.has(u.href)) { seen.add(u.href); urls.push(u.href); }
  }
  return urls;
}

function renderBulkProgress(entries, total) {
  var box = $('bulk-progress');
  box.innerHTML = '';
  entries.forEach(function (e) {
    var row = document.createElement('div');
    row.className = 'bl-row';
    var st = document.createElement('span');
    st.className = 'bl-status ' + (e.ok ? 'ok' : 'fail');
    st.textContent = e.ok ? '✓' : '✕';
    var url = document.createElement('span');
    url.className = 'bl-url';
    url.textContent = e.url + (e.ok ? '' : ' — ' + (e.error || 'failed'));
    var meta = document.createElement('span');
    meta.className = 'bl-meta';
    meta.textContent = e.ok ? e.found + ' found' : '';
    row.appendChild(st); row.appendChild(url); row.appendChild(meta);
    box.appendChild(row);
  });
  if (entries.length < total) {
    var pending = document.createElement('div');
    pending.className = 'bl-row';
    pending.innerHTML = '<span class="bl-status pending">◌</span>' +
      '<span class="bl-url">fetching ' + (entries.length + 1) + ' of ' + total + '…</span>';
    box.appendChild(pending);
  }
  show(box);
}

function showBulkDone(state) {
  bulkRows = state.rows || [];
  $('bulk-count').textContent = bulkRows.length;
  var failures = state.failures || [];
  $('bulk-sub').textContent =
    (state.total || 0) + ' URLs processed · ' + failures.length + ' failed' +
    (state.status === 'cancelled' ? ' · batch stopped early' : '');
  show($('bulk-done'));
  hide($('btn-bulk-cancel'));
  $('btn-bulk').disabled = false;
}

function startBulk() {
  hide($('bulk-error'));
  hide($('bulk-done'));
  var urls;
  try {
    urls = parseBulkUrls($('bulk-urls').value);
  } catch (err) {
    fail($('bulk-error'), err.message);
    return;
  }
  $('btn-bulk').disabled = true;
  show($('btn-bulk-cancel'));
  renderBulkProgress([], urls.length);

  sendToBackground({ type: 'LL_CLEAR_BULK', origin: origin }).then(function () {
    return ensureInjected();
  }).then(function () {
    return sendToTab({ type: 'LL_BULK_START', urls: urls });
  }).then(function (res) {
    if (!res || !res.ok) {
      $('btn-bulk').disabled = false;
      hide($('btn-bulk-cancel'));
      fail($('bulk-error'), (res && res.error) || 'Could not start the batch.');
    }
  }).catch(function (err) {
    $('btn-bulk').disabled = false;
    hide($('btn-bulk-cancel'));
    fail($('bulk-error'), 'Could not start on this page: ' + err.message);
  });
}

function restoreBulkState() {
  sendToBackground({ type: 'LL_GET_BULK', origin: origin }).then(function (res) {
    var state = res && res.state;
    if (!state) return;
    if (state.progress && state.progress.length) {
      renderBulkProgress(state.progress, state.total || state.progress.length);
    }
    if (state.status === 'done' || state.status === 'cancelled') {
      showBulkDone(state);
    } else if (state.status === 'running') {
      $('btn-bulk').disabled = true;
      show($('btn-bulk-cancel'));
    }
  });
}

function downloadBulkCsv() {
  if (!bulkRows) return;
  var csv = ns.csv.build(
    ['source_url', 'anchor_text', 'target_url', 'match_type', 'context_sentence'],
    bulkRows
  );
  ns.csv.download('link-lens-bulk-' + new URL(origin).hostname + '.csv', csv, document);
}

/* ------------------------------------------------------------------ *
 * Live messages from the tab (progress streaming)
 * ------------------------------------------------------------------ */

var bulkLive = []; // progress entries received while popup is open

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'LL_PROGRESS') {
    var prog = $('scan-progress');
    prog.innerHTML = '<span class="spin">◌</span> ' + '';
    prog.appendChild(document.createTextNode(msg.message));
    show(prog);
  }

  if (msg.type === 'LL_BULK_PROGRESS') {
    bulkLive.push({ url: msg.url, ok: msg.ok, error: msg.error, found: msg.found });
    renderBulkProgress(bulkLive, msg.total);
  }

  if (msg.type === 'LL_BULK_DONE') {
    showBulkDone({
      rows: msg.rows,
      failures: msg.failures,
      total: msg.total,
      status: msg.cancelled ? 'cancelled' : 'done'
    });
  }
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function switchTab(name) {
  var scan = name === 'scan';
  $('tab-scan').classList.toggle('active', scan);
  $('tab-bulk').classList.toggle('active', !scan);
  $('tab-scan').setAttribute('aria-selected', String(scan));
  $('tab-bulk').setAttribute('aria-selected', String(!scan));
  $('view-scan').classList.toggle('active', scan);
  $('view-bulk').classList.toggle('active', !scan);
}

document.addEventListener('DOMContentLoaded', function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    tab = tabs && tabs[0];
    var usable = tab && tab.url && /^https?:/.test(tab.url);
    if (!usable) {
      $('cache-dot').className = 'dot';
      $('cache-text').textContent = 'Link Lens only works on http(s) pages.';
      $('btn-scan').disabled = true;
      $('btn-rebuild').disabled = true;
      $('btn-bulk').disabled = true;
      return;
    }
    origin = new URL(tab.url).origin;
    $('bulk-domain').textContent = new URL(origin).hostname;
    refreshCacheStatus();
    restoreBulkState();
  });

  $('tab-scan').addEventListener('click', function () { switchTab('scan'); });
  $('tab-bulk').addEventListener('click', function () { switchTab('bulk'); });

  $('btn-scan').addEventListener('click', function () { runScan('LL_SCAN'); });
  $('btn-debug').addEventListener('click', function () {
    var info = {
      extension: 'Link Lens ' + chrome.runtime.getManifest().version,
      page: tab && tab.url,
      summary: lastSummary
    };
    navigator.clipboard.writeText(JSON.stringify(info, null, 2)).then(function () {
      $('btn-debug').textContent = '✓ Copied — paste it when reporting';
      setTimeout(function () { $('btn-debug').textContent = 'Copy debug info'; }, 2000);
    });
  });
  $('btn-rebuild').addEventListener('click', function () { runScan('LL_REBUILD'); });
  $('btn-clear').addEventListener('click', function () {
    sendToTab({ type: 'LL_CLEAR' }).catch(function () { /* not injected: nothing to clear */ });
    hide($('scan-result'));
  });

  $('btn-bulk').addEventListener('click', startBulk);
  $('btn-bulk-cancel').addEventListener('click', function () {
    sendToTab({ type: 'LL_BULK_CANCEL' }).catch(function () { });
    hide($('btn-bulk-cancel'));
    $('btn-bulk').disabled = false;
  });
  $('btn-bulk-csv').addEventListener('click', downloadBulkCsv);
  $('btn-bulk-reset').addEventListener('click', function () {
    sendToBackground({ type: 'LL_CLEAR_BULK', origin: origin });
    bulkRows = null;
    bulkLive = [];
    hide($('bulk-done'));
    hide($('bulk-progress'));
  });
});
