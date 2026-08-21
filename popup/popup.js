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
  'shared/textstats.js',
  'shared/intel.js',
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

/**
 * Make sure we can script the current site. activeTab (icon click) covers
 * the first run; otherwise ask Chrome ONCE for this site via optional
 * host permissions — after the user approves, scans work on this site
 * permanently, across tab switches and reloads.
 */
function ensureSiteAccess() {
  return new Promise(function (resolve, reject) {
    var req = { origins: [origin + '/*'] };
    chrome.permissions.contains(req, function (has) {
      if (has) return resolve(true);
      chrome.permissions.request(req, function (granted) {
        void chrome.runtime.lastError;
        resolve(!!granted); // not granted → fall back to activeTab attempt
      });
    });
  });
}

function injectBundle() {
  return chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: CONTENT_FILES
  }).then(function () {
    return sendToTab({ type: 'LL_PING' });
  });
}

/** Inject the content bundle once; a live LL_PING short-circuits. */
function ensureInjected() {
  return sendToTab({ type: 'LL_PING' }).catch(function () {
    return ensureSiteAccess().then(injectBundle);
  });
}

function fail(el, message) {
  el.textContent = message;
  show(el);
}

/** Map Chrome's activeTab denial to an actionable instruction. */
function friendlyError(err) {
  var m = String(err && err.message || err);
  if (/cannot access|cannot be scripted|activeTab|not been invoked|missing host permission/i.test(m)) {
    return 'Chrome blocked access to this page. Click the button again and choose "Allow" when Chrome asks for permission on this site (one-time per site).';
  }
  return 'Could not run on this page: ' + m;
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
    fail($('scan-error'), friendlyError(err));
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
    fail($('bulk-error'), friendlyError(err));
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
    ['source_url', 'anchor_text', 'target_url', 'match_type', 'position', 'context_sentence'],
    bulkRows
  );
  ns.csv.download('link-lens-bulk-' + new URL(origin).hostname + '.csv', csv, document);
}

/* ------------------------------------------------------------------ *
 * Keyword tab
 * ------------------------------------------------------------------ */

var kwRows = null;
var kwLive = [];

function startKeyword() {
  hide($('kw-error'));
  hide($('kw-done'));
  var keyword = $('kw-keyword').value.trim();
  if (!keyword) { fail($('kw-error'), 'Enter a keyword first.'); return; }
  var targetUrl = $('kw-target').value.trim() || null;
  if (targetUrl) {
    try {
      if (new URL(targetUrl).origin !== origin) {
        fail($('kw-error'), 'Target URL must be on ' + new URL(origin).hostname);
        return;
      }
    } catch (e) { fail($('kw-error'), 'Target URL is not a valid URL.'); return; }
  }
  kwLive = [];
  $('btn-kw').disabled = true;
  show($('btn-kw-cancel'));
  renderKwProgress([], 0);

  ensureInjected().then(function () {
    return sendToTab({ type: 'LL_KEYWORD_START', keyword: keyword, targetUrl: targetUrl });
  }).then(function (res) {
    if (!res || !res.ok) {
      $('btn-kw').disabled = false;
      hide($('btn-kw-cancel'));
      fail($('kw-error'), (res && res.error) || 'Could not start.');
    }
  }).catch(function (err) {
    $('btn-kw').disabled = false;
    hide($('btn-kw-cancel'));
    fail($('kw-error'), friendlyError(err));
  });
}

function renderKwProgress(entries, total) {
  var box = $('kw-progress');
  box.innerHTML = '';
  entries.forEach(function (e) {
    var row = document.createElement('div');
    row.className = 'bl-row';
    row.innerHTML = '<span class="bl-status ' + (e.ok ? 'ok' : 'fail') + '">' +
      (e.ok ? '✓' : '✕') + '</span>';
    var url = document.createElement('span');
    url.className = 'bl-url';
    url.textContent = e.url + (e.ok ? (e.alreadyLinked ? ' — already linked ✓' : '') : ' — ' + (e.error || 'failed'));
    var meta = document.createElement('span');
    meta.className = 'bl-meta';
    meta.textContent = e.ok && !e.alreadyLinked ? (e.found + ' found') : '';
    row.appendChild(url); row.appendChild(meta);
    box.appendChild(row);
  });
  if (total === 0 || entries.length < total) {
    var pending = document.createElement('div');
    pending.className = 'bl-row';
    pending.innerHTML = '<span class="bl-status pending">◌</span>' +
      '<span class="bl-url">checking ' + (entries.length + 1) +
      (total ? ' of ' + total : '') + '…</span>';
    box.appendChild(pending);
  }
  show(box);
}

function showKwDone(msg) {
  kwRows = msg.rows || [];
  $('kw-count').textContent = kwRows.length;
  $('kw-sub').textContent =
    (msg.total || 0) + ' pages checked · ' + (msg.skippedLinked || 0) + ' already link the target · ' +
    ((msg.failures || []).length) + ' failed' +
    (msg.targetUrl ? ' · target: ' + msg.targetUrl : '');
  show($('kw-done'));
  hide($('btn-kw-cancel'));
  $('btn-kw').disabled = false;
}

function downloadKwCsv() {
  if (!kwRows) return;
  var csv = ns.csv.build(
    ['page_url', 'suggested_anchor', 'keyword', 'target_url', 'position', 'relevance', 'context_sentence'],
    kwRows
  );
  ns.csv.download('link-lens-keyword-' + new URL(origin).hostname + '.csv', csv, document);
}

/** Highlight the keyword's opportunities inline on the CURRENT page. */
function keywordHere() {
  hide($('kw-error'));
  hide($('kw-here-result'));
  var keyword = $('kw-keyword').value.trim();
  if (!keyword) { fail($('kw-error'), 'Enter a keyword first.'); return; }
  var targetUrl = $('kw-target').value.trim() || null;
  $('btn-kw-here').disabled = true;

  ensureInjected().then(function () {
    return sendToTab({ type: 'LL_KEYWORD_HERE', keyword: keyword, targetUrl: targetUrl });
  }).then(function (res) {
    $('btn-kw-here').disabled = false;
    if (!res || !res.ok) {
      fail($('kw-error'), (res && res.error) || 'Could not scan this page.');
      return;
    }
    if (res.alreadyLinked) {
      $('kw-here-count').textContent = '✓';
      $('kw-here-label').textContent = 'this page already links the target';
      $('kw-here-sub').textContent = res.targetUrl || '';
    } else {
      $('kw-here-count').textContent = res.found;
      $('kw-here-label').textContent = res.found === 1
        ? 'spot highlighted on this page' : 'spots highlighted on this page';
      $('kw-here-sub').textContent = res.targetUrl
        ? 'linking to: ' + res.targetUrl
        : 'no matching target in the index — add a target URL above';
    }
    show($('kw-here-result'));
  }).catch(function (err) {
    $('btn-kw-here').disabled = false;
    fail($('kw-error'), friendlyError(err));
  });
}

/* ------------------------------------------------------------------ *
 * Site intel tab — crawl + reports
 * ------------------------------------------------------------------ */

var intelReport = null;

function renderCrawlStatus(c) {
  var dot = $('crawl-dot');
  if (!c) {
    dot.className = 'dot stale';
    $('crawl-text').textContent = 'No crawl yet for this site';
    $('crawl-sub').textContent = 'A crawl unlocks scoring, orphan pages and anchor audits.';
    hide($('intel-reports'));
    hide($('crawl-progress'));
    return;
  }
  var running = c.status === 'running';
  dot.className = 'dot ' + (c.status === 'done' ? 'fresh' : 'stale');
  $('crawl-text').textContent = running
    ? 'Crawling… ' + c.done + ' of ' + c.total
    : (c.status === 'done' ? 'Crawl complete — ' + c.pages + ' pages indexed'
      : 'Crawl paused — ' + c.pages + ' pages indexed');
  $('crawl-sub').textContent = c.failed
    ? c.failed + ' pages failed · ' + (c.remaining || 0) + ' remaining'
    : (c.remaining ? c.remaining + ' remaining' : 'Scans now use the intelligence model.');

  $('btn-crawl').disabled = running;
  $('btn-crawl').textContent = (!running && c.remaining > 0)
    ? '▶ Resume crawl (' + c.remaining + ' left)' : '🕷 Start site crawl';
  if (running) show($('btn-crawl-stop')); else hide($('btn-crawl-stop'));

  var pct = c.total ? Math.round((c.done + c.failed) / c.total * 100) : 0;
  $('crawl-progress').innerHTML = '<div>' + pct + '% · ' + c.done + ' crawled, ' +
    c.failed + ' failed</div><div class="bar"><i style="width:' + pct + '%"></i></div>';
  show($('crawl-progress'));

  if (c.pages > 0 && !running) loadIntelReports();
}

function refreshCrawlStatus() {
  sendToBackground({ type: 'LL_CRAWL_STATUS', origin: origin }).then(function (res) {
    renderCrawlStatus(res && res.crawl);
  });
}

function startCrawl() {
  hide($('crawl-error'));
  $('btn-crawl').disabled = true;
  var limit = parseInt($('crawl-limit').value, 10);
  var delayMs = parseInt($('crawl-speed').value, 10);

  ensureInjected().then(function () {
    return sendToTab({ type: 'LL_INDEX_URLS', force: false });
  }).then(function (res) {
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not read the site index.');
    if (res.shallow) {
      throw new Error('No sitemap found for this site, so there is no URL list to crawl.');
    }
    return sendToBackground({
      type: 'LL_CRAWL_START', origin: origin,
      urls: res.urls, limit: limit, delayMs: delayMs
    });
  }).then(function (res) {
    if (!res || !res.ok) {
      $('btn-crawl').disabled = false;
      fail($('crawl-error'), (res && res.error) || 'Could not start the crawl.');
      return;
    }
    refreshCrawlStatus();
  }).catch(function (err) {
    $('btn-crawl').disabled = false;
    fail($('crawl-error'), friendlyError(err));
  });
}

function loadIntelReports() {
  ensureInjected().then(function () {
    return sendToTab({ type: 'LL_INTEL_REPORT' });
  }).then(function (res) {
    if (!res || !res.ok) return;
    intelReport = res;
    $('orphan-count').textContent = res.orphans.length;
    $('risk-count').textContent = res.anchorRisks.length;
    var box = $('intel-list');
    box.innerHTML = '';
    res.orphans.slice(0, 40).forEach(function (o) {
      var row = document.createElement('div');
      row.className = 'bl-row';
      var u = document.createElement('span');
      u.className = 'bl-url';
      u.textContent = o.title || o.url;
      var m = document.createElement('span');
      m.className = 'bl-meta';
      m.textContent = 'orphan';
      row.appendChild(u); row.appendChild(m);
      box.appendChild(row);
    });
    if (res.orphans.length === 0) {
      box.innerHTML = '<div class="bl-row"><span class="bl-url">' +
        'No orphan pages — every crawled page has at least one internal link. ✓</span></div>';
    }
    show($('intel-reports'));
  }).catch(function () { /* crawl not ready */ });
}

function downloadOrphanCsv() {
  if (!intelReport) return;
  var rows = intelReport.underLinked.map(function (r) {
    return [r.url, r.title, r.inbound, r.words, r.inbound === 0 ? 'ORPHAN' : ''];
  });
  ns.csv.download('link-lens-link-equity-' + new URL(origin).hostname + '.csv',
    ns.csv.build(['url', 'title', 'inbound_internal_links', 'word_count', 'flag'], rows), document);
}

function downloadAnchorCsv() {
  if (!intelReport) return;
  var rows = intelReport.anchorRisks.map(function (r) {
    return [r.url, r.anchor, r.uses, r.total, r.share + '%', r.variants];
  });
  ns.csv.download('link-lens-anchors-' + new URL(origin).hostname + '.csv',
    ns.csv.build(['target_url', 'dominant_anchor', 'uses', 'total_links',
      'share_of_anchors', 'anchor_variants'], rows), document);
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

  if (msg.type === 'LL_KEYWORD_PROGRESS') {
    kwLive.push({ url: msg.url, ok: msg.ok, error: msg.error, found: msg.found, alreadyLinked: msg.alreadyLinked });
    renderKwProgress(kwLive, msg.total);
  }

  if (msg.type === 'LL_KEYWORD_DONE') {
    showKwDone(msg);
  }

  if (msg.type === 'LL_CRAWL_PROGRESS' && msg.origin === origin) {
    renderCrawlStatus({
      status: msg.status, done: msg.done, failed: msg.failed,
      total: msg.total, pages: msg.pages,
      remaining: Math.max(0, (msg.total || 0) - (msg.done || 0) - (msg.failed || 0))
    });
  }
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function switchTab(name) {
  if (name === 'intel') refreshCrawlStatus();
  ['scan', 'bulk', 'kw', 'intel'].forEach(function (t) {
    var on = t === name;
    $('tab-' + t).classList.toggle('active', on);
    $('tab-' + t).setAttribute('aria-selected', String(on));
    $('view-' + t).classList.toggle('active', on);
  });
}

/**
 * (Re)bind the panel to the current active tab. The side panel outlives
 * tab switches and navigations, so this runs on load AND whenever the
 * active tab changes.
 */
var initRetried = false;

function initPanel() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    tab = tabs && tabs[0];
    var usable = tab && tab.url && /^https?:/.test(tab.url);
    var buttons = ['btn-scan', 'btn-rebuild', 'btn-bulk', 'btn-kw', 'btn-kw-here', 'btn-crawl'];
    if (!usable) {
      // The URL can lag the panel's first paint by a beat — retry once
      // before declaring the tab unusable.
      if (tab && !tab.url && !initRetried) {
        initRetried = true;
        setTimeout(initPanel, 500);
        return;
      }
      $('cache-dot').className = 'dot';
      $('cache-text').textContent = 'Link Lens works on http(s) pages.';
      $('cache-sub').textContent = tab && !tab.url
        ? 'Click the Link Lens toolbar icon once on this tab to activate it.'
        : 'Open a page of your site, then click the Link Lens toolbar icon.';
      buttons.forEach(function (id) { $(id).disabled = true; });
      return;
    }
    initRetried = false;
    var newOrigin = new URL(tab.url).origin;
    if (newOrigin !== origin) {
      // switched sites: stale results would be misleading
      hide($('scan-result'));
      hide($('bulk-done'));
      hide($('kw-done'));
      hide($('kw-here-result'));
    }
    origin = newOrigin;
    buttons.forEach(function (id) { $(id).disabled = false; });
    $('bulk-domain').textContent = new URL(origin).hostname;
    refreshCacheStatus();
    restoreBulkState();
  });
}

document.addEventListener('DOMContentLoaded', function () {
  initPanel();
  // Follow the user across tabs and navigations (side panel persists).
  if (chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(function () { initPanel(); });
    chrome.tabs.onUpdated.addListener(function (tabId, info) {
      if (info.status === 'complete') initPanel();
    });
  }

  $('tab-scan').addEventListener('click', function () { switchTab('scan'); });
  $('tab-bulk').addEventListener('click', function () { switchTab('bulk'); });
  $('tab-kw').addEventListener('click', function () { switchTab('kw'); });
  $('btn-kw').addEventListener('click', startKeyword);
  $('btn-kw-here').addEventListener('click', keywordHere);
  $('btn-kw-cancel').addEventListener('click', function () {
    sendToTab({ type: 'LL_BULK_CANCEL' }).catch(function () { });
    hide($('btn-kw-cancel'));
    $('btn-kw').disabled = false;
  });
  $('btn-kw-csv').addEventListener('click', downloadKwCsv);
  $('tab-intel').addEventListener('click', function () { switchTab('intel'); });
  $('btn-crawl').addEventListener('click', startCrawl);
  $('btn-crawl-stop').addEventListener('click', function () {
    sendToBackground({ type: 'LL_CRAWL_STOP' }).then(refreshCrawlStatus);
  });
  $('btn-orphan-csv').addEventListener('click', downloadOrphanCsv);
  $('btn-anchor-csv').addEventListener('click', downloadAnchorCsv);
  $('btn-crawl-clear').addEventListener('click', function () {
    sendToBackground({ type: 'LL_CRAWL_CLEAR', origin: origin }).then(function () {
      intelReport = null;
      hide($('intel-reports'));
      refreshCrawlStatus();
    });
  });

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
