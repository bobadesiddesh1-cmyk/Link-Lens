/**
 * Link Lens — popup/popup.js
 * Scan tab: injects the content-script bundle into the active tab
 * (activeTab + scripting) and drives LL_SCAN / LL_REBUILD / LL_CLEAR.
 * Bulk / Keyword / Site intel tabs: drive the background worker
 * (crawler + planner in the offscreen document) via background.js and
 * render its persisted progress, so runs survive the panel closing.
 */
'use strict';

var ns = self.__linkLens; // tokenizer + csv, loaded by popup.html

var CONTENT_FILES = [
  'shared/tokenizer.js',
  'shared/textstats.js',
  'shared/gsc.js',
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
  if (lines.length > 500) throw new Error('Maximum 500 URLs per batch (you pasted ' + lines.length + ').');
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
  var resume = canResume('audit');

  // The site index must exist for the background worker; a scan builds it.
  ensureInjected().then(function () {
    return sendToTab({ type: 'LL_INDEX_URLS', force: false });
  }).then(function () {
    // A paused batch resumes where it stopped; anything else starts clean.
    if (!resume) return sendToBackground({ type: 'LL_PLAN_CLEAR', mode: 'audit', origin: origin });
  }).then(function () {
    return sendToBackground({
      type: 'LL_PLAN_START', mode: 'audit', origin: origin, urls: urls, fresh: !resume,
      limit: 500, delayMs: parseInt($('crawl-speed').value, 10) || 1000
    });
  }).then(function (res) {
    if (!res || !res.ok) {
      $('btn-bulk').disabled = false;
      hide($('btn-bulk-cancel'));
      fail($('bulk-error'), (res && res.error) || 'Could not start the batch.');
      return;
    }
    refreshRun('audit');
  }).catch(function (err) {
    $('btn-bulk').disabled = false;
    hide($('btn-bulk-cancel'));
    fail($('bulk-error'), friendlyError(err));
  });
}

var runState = { audit: null, keywords: null }; // last known background state

/** Is there a paused run of this mode that the Start button should resume? */
function canResume(mode, keywords) {
  var p = runState[mode];
  if (!p || p.status === 'running' || !(p.remaining > 0)) return false;
  if (mode === 'keywords') {
    // Changing the keyword list means a new run, not a resume.
    var prev = (p.keywords || []).slice().sort().join('\n');
    var next = (keywords || []).slice().sort().join('\n');
    return prev === next;
  }
  return true;
}

/** Render progress for a background run (audit / keywords) into its tab. */
function renderRun(mode, p) {
  runState[mode] = p || null;
  var ids = mode === 'audit'
    ? { prog: 'bulk-progress', btn: 'btn-bulk', stop: 'btn-bulk-cancel', done: 'bulk-done',
        count: 'bulk-count', sub: 'bulk-sub', err: 'bulk-error' }
    : { prog: 'kw-progress', btn: 'btn-kw', stop: 'btn-kw-cancel', done: 'kw-done',
        count: 'kw-count', sub: 'kw-sub', err: 'kw-error' };
  if (!p) { hide($(ids.prog)); return; }
  if (p.status === 'error') {
    fail($(ids.err), p.error || p.lastError || 'The background run hit an error.');
    $(ids.btn).disabled = false; hide($(ids.stop)); hide($(ids.prog));
    return;
  }
  var running = p.status === 'running';
  var pct = p.total ? Math.round((p.done + p.failed) / p.total * 100) : 0;
  $(ids.prog).innerHTML = '<div>' + (running ? 'Checking… ' : 'Checked ') + pct + '% · ' +
    p.done + ' of ' + p.total + ' pages · ' + p.links + ' found' +
    (p.failed ? ' · ' + p.failed + ' failed' : '') +
    (p.linked ? ' · ' + p.linked + ' already linked' : '') +
    '</div><div class="bar"><i style="width:' + pct + '%"></i></div>';
  show($(ids.prog));
  $(ids.btn).disabled = running;
  $(ids.stop).classList.toggle('hidden', !running);
  if (!running && p.remaining > 0) {
    $(ids.btn).textContent = '▶ Resume (' + p.remaining + ' pages left)';
  } else {
    $(ids.btn).textContent = mode === 'audit' ? 'Run bulk audit'
      : 'Check the whole site for link placements';
  }
  if (!running && (p.status === 'done' || p.status === 'paused')) {
    $(ids.count).textContent = p.links;
    $(ids.sub).textContent = p.done + ' pages checked · ' + (p.failed || 0) + ' failed' +
      (p.linked ? ' · ' + p.linked + ' page/keyword pairs already linked' : '') +
      (p.status === 'paused' ? ' · paused' : '');
    if (p.links > 0 || p.status === 'done') show($(ids.done));
  }
}

function refreshRun(mode) {
  sendToBackground({ type: 'LL_PLAN_STATUS', mode: mode, origin: origin }).then(function (res) {
    renderRun(mode, res && res.plan);
  });
}

function downloadRunCsv(mode) {
  sendToBackground({ type: 'LL_PLAN_ROWS', mode: mode, origin: origin }).then(function (res) {
    if (!res || !res.rows || !res.rows.length) return;
    var header = mode === 'keywords'
      ? ['page_url', 'suggested_anchor', 'keyword', 'target_url', 'target_gsc_position',
         'keyword_impressions', 'position', 'relevance', 'context_sentence']
      : ['source_url', 'anchor_text', 'target_url', 'target_keyword', 'target_title', 'score',
         'match_type', 'position', 'target_inbound_links', 'target_gsc_position',
         'target_gsc_clicks', 'why', 'context_sentence'];
    var name = mode === 'keywords' ? 'keyword-placements' : (mode === 'audit' ? 'bulk-audit' : 'site-plan');
    ns.csv.download('link-lens-' + name + '-' + new URL(origin).hostname + '.csv',
      ns.csv.build(header, res.rows), document);
  });
}

function restoreBulkState() {
  refreshRun('audit');
  refreshRun('keywords');
}

function downloadBulkCsv() { downloadRunCsv('audit'); }

/* ------------------------------------------------------------------ *
 * Keyword tab
 * ------------------------------------------------------------------ */


function keywordList() {
  return $('kw-keyword').value.split(/[,\n;]+/).map(function (k) { return k.trim(); })
    .filter(function (k, i, arr) { return k && arr.indexOf(k) === i; });
}

function startKeyword() {
  hide($('kw-error'));
  hide($('kw-done'));
  var keywords = keywordList();
  if (keywords.length === 0) { fail($('kw-error'), 'Enter at least one keyword.'); return; }
  var targetUrl = $('kw-target').value.trim() || null;
  if (targetUrl) {
    try {
      if (new URL(targetUrl).origin !== origin) {
        fail($('kw-error'), 'Target URL must be on ' + new URL(origin).hostname);
        return;
      }
    } catch (e) { fail($('kw-error'), 'Target URL is not a valid URL.'); return; }
  }
  $('btn-kw').disabled = true;
  show($('btn-kw-cancel'));
  var resume = canResume('keywords', keywords);

  ensureInjected().then(function () {
    return sendToTab({ type: 'LL_INDEX_URLS', force: false }); // guarantees an index
  }).then(function () {
    if (!resume) return sendToBackground({ type: 'LL_PLAN_CLEAR', mode: 'keywords', origin: origin });
  }).then(function () {
    return sendToBackground({
      type: 'LL_PLAN_START', mode: 'keywords', origin: origin, fresh: !resume,
      keywords: keywords, targetUrl: targetUrl, limit: 2000,
      delayMs: parseInt($('crawl-speed').value, 10) || 1000
    });
  }).then(function (res) {
    if (!res || !res.ok) {
      $('btn-kw').disabled = false;
      hide($('btn-kw-cancel'));
      fail($('kw-error'), (res && res.error) || 'Could not start.');
      return;
    }
    refreshRun('keywords');
  }).catch(function (err) {
    $('btn-kw').disabled = false;
    hide($('btn-kw-cancel'));
    fail($('kw-error'), friendlyError(err));
  });
}

function showVariants() {
  hide($('kw-error'));
  var keywords = keywordList();
  if (keywords.length === 0) { fail($('kw-error'), 'Enter a keyword first.'); return; }
  $('btn-kw-variants').disabled = true;
  ensureInjected().then(function () {
    return sendToTab({ type: 'LL_KEYWORD_VARIANTS', keywords: keywords,
      targetUrl: $('kw-target').value.trim() || null });
  }).then(function (res) {
    $('btn-kw-variants').disabled = false;
    if (!res || !res.ok) { fail($('kw-error'), (res && res.error) || 'Could not build variations.'); return; }
    var box = $('kw-variants');
    box.innerHTML = '';
    res.keywords.forEach(function (k) {
      var head = document.createElement('div');
      head.className = 'chips-head';
      head.textContent = k.keyword + (k.targetUrl ? ' → ' + k.targetUrl.replace(origin, '') : ' (no target found)');
      box.appendChild(head);
      if (!k.variants.length) return;
      k.variants.forEach(function (v) {
        var chip = document.createElement('span');
        chip.className = 'chip ' + v.source;
        chip.title = v.source === 'template' ? 'suggested phrasing (not yet used on the site)'
          : v.source === 'anchor' ? 'anchor already used for this page ' + v.count + '×'
          : v.source === 'title' ? 'from a page title on this site'
          : 'related page title on this site';
        chip.textContent = v.text;
        if (v.count > 1) { var n = document.createElement('small'); n.textContent = '×' + v.count; chip.appendChild(n); }
        chip.addEventListener('click', function () {
          var cur = keywordList();
          if (cur.indexOf(v.text) === -1) cur.push(v.text);
          $('kw-keyword').value = cur.join(', ');
        });
        box.appendChild(chip);
      });
    });
    if (!res.hasModel) {
      var note = document.createElement('div');
      note.className = 'chips-head';
      note.textContent = 'Run a site crawl (Site intel tab) to mine real phrasings from your pages — only generic suggestions are shown now.';
      box.appendChild(note);
    }
    show(box);
  }).catch(function (err) {
    $('btn-kw-variants').disabled = false;
    fail($('kw-error'), friendlyError(err));
  });
}

/** Highlight the keyword's opportunities inline on the CURRENT page. */
function keywordHere() {
  hide($('kw-error'));
  hide($('kw-here-result'));
  var keywords = keywordList();
  if (keywords.length === 0) { fail($('kw-error'), 'Enter a keyword first.'); return; }
  var targetUrl = $('kw-target').value.trim() || null;
  $('btn-kw-here').disabled = true;

  ensureInjected().then(function () {
    return sendToTab({ type: 'LL_KEYWORD_HERE', keywords: keywords, targetUrl: targetUrl });
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
      $('kw-here-sub').textContent = (res.keywords || []).map(function (k) {
        return k.keyword + ': ' + (k.alreadyLinked ? 'already linked' : k.found + ' spot' + (k.found === 1 ? '' : 's')) +
          (k.targetUrl ? ' → ' + k.targetUrl.replace(origin, '') : ' (no target)');
      }).join(' · ');
    }
    show($('kw-here-result'));
  }).catch(function (err) {
    $('btn-kw-here').disabled = false;
    fail($('kw-error'), friendlyError(err));
  });
}

/* ------------------------------------------------------------------ *
 * Search Console
 * ------------------------------------------------------------------ */

function renderGsc(g) {
  var dot = $('gsc-dot');
  if (!g) {
    dot.className = 'dot';
    $('gsc-text').textContent = 'Search Console not connected';
    $('gsc-sub').textContent = 'Connect to map keywords to the pages that actually ' +
      'rank for them, and to rank opportunities by real demand.';
    $('btn-gsc-connect').textContent = '🔗 Connect Google Search Console';
    show($('btn-gsc-connect'));
    hide($('gsc-actions'));
    return;
  }
  dot.className = 'dot fresh';
  var t = g.totals || {};
  $('gsc-text').textContent = 'Search Console — ' + (t.pages || 0) + ' pages with queries';
  $('gsc-sub').textContent = (g.label || g.property) + ' · ' +
    (t.clicks || 0).toLocaleString() + ' clicks · ' +
    (t.impressions || 0).toLocaleString() + ' impressions · ' +
    g.startDate + ' → ' + g.endDate + ' · synced ' + timeAgo(g.updatedAt);
  hide($('btn-gsc-connect'));
  show($('gsc-actions'));
}

function refreshGsc() {
  sendToBackground({ type: 'LL_GSC_STATUS', origin: origin }).then(function (res) {
    renderGsc(res && res.gsc);
  });
}

function gscBusy(busy, label) {
  $('btn-gsc-connect').disabled = busy;
  $('btn-gsc-sync').disabled = busy;
  if (busy) {
    $('gsc-progress').innerHTML = '<span class="spin">◌</span> ' + label;
    show($('gsc-progress'));
  } else {
    hide($('gsc-progress'));
  }
}

function connectGsc() {
  hide($('gsc-error'));
  // Must run synchronously inside the click: chrome.permissions.request
  // needs a user gesture, and the service worker never has one. Calling
  // it when the permission is already held resolves true immediately.
  chrome.permissions.request({ origins: ['https://www.googleapis.com/*'] }, function (granted) {
    void chrome.runtime.lastError;
    if (!granted) {
      fail($('gsc-error'), 'Link Lens needs access to googleapis.com to read your ' +
        'Search Console data. Click Connect again and choose Allow.');
      return;
    }
    gscBusy(true, 'Waiting for Google sign-in…');
    startGscConnect();
  });
}

function startGscConnect() {
  sendToBackground({ type: 'LL_GSC_CONNECT', origin: origin }).then(function (res) {
    gscBusy(false);
    if (!res || !res.ok) {
      var msg = (res && res.error) || 'Could not connect to Search Console.';
      if (res && res.noProperty && res.properties && res.properties.length) {
        msg += ' Properties on this account: ' + res.properties.slice(0, 6).join(', ');
      }
      fail($('gsc-error'), msg);
      return;
    }
    renderGsc(res.gsc);
  });
}

function syncGsc() {
  hide($('gsc-error'));
  gscBusy(true, 'Fetching Search Console data…');
  sendToBackground({ type: 'LL_GSC_SYNC', origin: origin }).then(function (res) {
    gscBusy(false);
    if (!res || !res.ok) {
      fail($('gsc-error'), (res && res.error) || 'Refresh failed.');
      return;
    }
    renderGsc(res.gsc);
  });
}

function disconnectGsc() {
  hide($('gsc-error'));
  sendToBackground({ type: 'LL_GSC_DISCONNECT', origin: origin }).then(function () {
    renderGsc(null);
  });
}

/* ------------------------------------------------------------------ *
 * Site intel tab — crawl + reports
 * ------------------------------------------------------------------ */

var intelReport = null;

function renderCrawlStatus(c) {
  var dot = $('crawl-dot');
  if (c && c.status === 'error') {
    dot.className = 'dot stale';
    $('crawl-text').textContent = 'Crawl stopped';
    $('crawl-sub').textContent = '';
    fail($('crawl-error'), c.error || c.lastError || 'The crawler hit an error.');
    $('btn-crawl').disabled = false;
    hide($('btn-crawl-stop'));
    return;
  }
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
  refreshPlanStatus();
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
    $('cannibal-count').textContent = res.cannibals ? res.cannibals.length : 0;
    $('buried-count').textContent = res.buried || 0;
    $('btn-cannibal-csv').classList.toggle('hidden', !(res.cannibals && res.cannibals.length));
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
    var flags = [];
    if (r.inbound === 0) flags.push('ORPHAN');
    if (r.clickDepth === '' || r.clickDepth > 3) flags.push('BURIED');
    return [r.url, r.title, r.inbound, r.authority == null ? '' : r.authority,
      r.clickDepth == null ? '' : r.clickDepth, r.words, flags.join(' ')];
  });
  ns.csv.download('link-lens-link-equity-' + new URL(origin).hostname + '.csv',
    ns.csv.build(['url', 'title', 'inbound_internal_links', 'internal_authority',
      'click_depth', 'word_count', 'flag'], rows), document);
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

function renderPlanStatus(p) {
  if (p && p.status === 'error') {
    fail($('plan-error'), p.error || p.lastError || 'The planner hit an error.');
    $('btn-plan').disabled = false;
    hide($('btn-plan-stop'));
    return;
  }
  if (!p) { hide($('plan-progress')); hide($('btn-plan-csv')); return; }
  var running = p.status === 'running';
  var pct = p.total ? Math.round((p.done + p.failed) / p.total * 100) : 0;
  $('plan-progress').innerHTML = '<div>' + (running ? 'Planning… ' : 'Plan ') +
    pct + '% · ' + p.done + ' pages, ' + p.links + ' links found' +
    (p.failed ? ', ' + p.failed + ' failed' : '') +
    '</div><div class="bar"><i style="width:' + pct + '%"></i></div>';
  show($('plan-progress'));
  $('btn-plan').disabled = running;
  $('btn-plan').textContent = (!running && p.remaining > 0)
    ? '▶ Resume plan (' + p.remaining + ' left)' : '🗺 Build site-wide link plan';
  $('btn-plan-stop').classList.toggle('hidden', !running);
  $('btn-plan-csv').classList.toggle('hidden', p.links === 0);
}

function refreshPlanStatus() {
  sendToBackground({ type: 'LL_PLAN_STATUS', mode: 'plan', origin: origin }).then(function (res) {
    renderPlanStatus(res && res.plan);
  });
}

function startPlan() {
  hide($('plan-error'));
  $('btn-plan').disabled = true;
  sendToBackground({
    type: 'LL_PLAN_START', mode: 'plan', origin: origin,
    limit: 500, delayMs: parseInt($('crawl-speed').value, 10) || 1000,
    maxPerPage: 3, maxPerTarget: 5, minScore: 45
  }).then(function (res) {
    if (!res || !res.ok) {
      $('btn-plan').disabled = false;
      fail($('plan-error'), (res && res.error) || 'Could not start the plan.');
      return;
    }
    refreshPlanStatus();
  });
}

function downloadPlanCsv() { downloadRunCsv('plan'); }

function downloadCannibalCsv() {
  if (!intelReport || !intelReport.cannibals) return;
  var rows = intelReport.cannibals.map(function (c) {
    return [c.urlA, c.titleA, c.inboundA, c.urlB, c.titleB, c.inboundB, c.similarity + '%'];
  });
  ns.csv.download('link-lens-cannibalization-' + new URL(origin).hostname + '.csv',
    ns.csv.build(['page_a', 'title_a', 'inbound_a', 'page_b', 'title_b', 'inbound_b',
      'topic_similarity'], rows), document);
}

/* ------------------------------------------------------------------ *
 * Live messages from the tab (progress streaming)
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'LL_PROGRESS') {
    var prog = $('scan-progress');
    prog.innerHTML = '<span class="spin">◌</span> ' + '';
    prog.appendChild(document.createTextNode(msg.message));
    show(prog);
  }

  if (msg.type === 'LL_PLAN_PROGRESS' && msg.origin === origin && msg.mode && msg.mode !== 'plan') {
    renderRun(msg.mode, {
      status: msg.status, done: msg.done, failed: msg.failed, total: msg.total,
      links: msg.links, error: msg.error, linked: msg.linked,
      keywords: (runState[msg.mode] || {}).keywords || [], // progress events omit them
      remaining: Math.max(0, (msg.total || 0) - (msg.done || 0) - (msg.failed || 0))
    });
  }

  if (msg.type === 'LL_PLAN_PROGRESS' && msg.origin === origin && (!msg.mode || msg.mode === 'plan')) {
    renderPlanStatus({
      status: msg.status, done: msg.done, failed: msg.failed, total: msg.total,
      links: msg.links, error: msg.error,
      remaining: Math.max(0, (msg.total || 0) - (msg.done || 0) - (msg.failed || 0))
    });
  }

  if (msg.type === 'LL_GSC_PROGRESS' && msg.origin === origin) {
    if (msg.status === 'running') {
      gscBusy(true, 'Fetching Search Console data… ' +
        (msg.rows || 0).toLocaleString() + ' rows');
    } else if (msg.status === 'error') {
      gscBusy(false);
      fail($('gsc-error'), msg.error || 'Search Console request failed.');
    } else {
      gscBusy(false);
    }
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
    refreshGsc();
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
    sendToBackground({ type: 'LL_PLAN_STOP' }).then(function () { refreshRun('keywords'); });
  });
  $('btn-kw-csv').addEventListener('click', function () { downloadRunCsv('keywords'); });
  $('btn-kw-variants').addEventListener('click', showVariants);
  $('tab-intel').addEventListener('click', function () { switchTab('intel'); });
  $('btn-crawl').addEventListener('click', startCrawl);
  $('btn-gsc-connect').addEventListener('click', connectGsc);
  $('btn-gsc-sync').addEventListener('click', syncGsc);
  $('btn-gsc-disconnect').addEventListener('click', disconnectGsc);
  $('btn-crawl-stop').addEventListener('click', function () {
    sendToBackground({ type: 'LL_CRAWL_STOP' }).then(refreshCrawlStatus);
  });
  $('btn-orphan-csv').addEventListener('click', downloadOrphanCsv);
  $('btn-anchor-csv').addEventListener('click', downloadAnchorCsv);
  $('btn-cannibal-csv').addEventListener('click', downloadCannibalCsv);
  $('btn-plan').addEventListener('click', startPlan);
  $('btn-plan-stop').addEventListener('click', function () {
    sendToBackground({ type: 'LL_PLAN_STOP' }).then(refreshPlanStatus);
  });
  $('btn-plan-csv').addEventListener('click', downloadPlanCsv);
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
    sendToBackground({ type: 'LL_PLAN_STOP' }).then(function () { refreshRun('audit'); });
  });
  $('btn-bulk-csv').addEventListener('click', downloadBulkCsv);
  $('btn-bulk-reset').addEventListener('click', function () {
    sendToBackground({ type: 'LL_PLAN_CLEAR', mode: 'audit', origin: origin });
    hide($('bulk-done'));
    hide($('bulk-progress'));
  });
});
