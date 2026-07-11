/**
 * Link Lens — content/card.js
 * Click-a-highlight card: Shadow DOM popover showing suggested anchor
 * text, target URL, match type, and a copy-ready HTML snippet.
 * Palette: Deep Ocean teal/cyan with a Sunset coral accent (see DECISIONS.md).
 */
(function (ns) {
  'use strict';
  if (ns.card) return; // idempotent re-injection guard

  var host = null;
  var shadow = null;

  var CSS = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; margin: 0; padding: 0; }',
    '.card {',
    '  position: absolute;',
    '  z-index: 2147483646;',
    '  width: 340px;',
    '  max-width: calc(100vw - 24px);',
    '  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
    '  font-size: 13px;',
    '  line-height: 1.45;',
    '  color: #0F172A;',
    '  background: #FFFFFF;',
    '  border: 1px solid #99F6E4;',
    '  border-top: 3px solid #0D9488;',
    '  border-radius: 10px;',
    '  box-shadow: 0 12px 32px rgba(13, 148, 136, 0.25), 0 2px 8px rgba(15, 23, 42, 0.12);',
    '  overflow: hidden;',
    '}',
    '.head {',
    '  display: flex; align-items: center; justify-content: space-between;',
    '  padding: 10px 12px;',
    '  background: linear-gradient(135deg, #0D9488 0%, #06B6D4 100%);',
    '  color: #FFFFFF;',
    '}',
    '.head .title { font-weight: 700; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; }',
    '.badge {',
    '  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;',
    '  padding: 2px 8px; border-radius: 999px; margin-left: 8px;',
    '}',
    '.badge.exact { background: #ECFDF5; color: #047857; }',
    '.badge.loose { background: #FEF3C7; color: #B45309; }',
    '.badge.heading { background: #FFF7ED; color: #C2410C; }',
    '.close {',
    '  background: rgba(255,255,255,0.18); border: 0; color: #fff; cursor: pointer;',
    '  width: 22px; height: 22px; border-radius: 6px; font-size: 14px; line-height: 1;',
    '}',
    '.close:hover { background: rgba(255,255,255,0.35); }',
    '.body { padding: 12px; }',
    '.row { margin-bottom: 10px; }',
    '.label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #0D9488; margin-bottom: 3px; }',
    '.anchor { font-weight: 600; font-size: 14px; }',
    '.target { color: #0369A1; word-break: break-all; font-size: 12px; }',
    '.snippet {',
    '  display: block; width: 100%;',
    '  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
    '  font-size: 11px; background: #F0FDFA; color: #134E4A;',
    '  border: 1px solid #99F6E4; border-radius: 6px; padding: 8px;',
    '  white-space: pre-wrap; word-break: break-all;',
    '}',
    '.copy {',
    '  display: inline-flex; align-items: center; gap: 6px;',
    '  margin-top: 8px; padding: 7px 14px;',
    '  font-size: 12px; font-weight: 700; color: #FFFFFF;',
    '  background: #F97316; border: 0; border-radius: 8px; cursor: pointer;',
    '  box-shadow: 0 2px 6px rgba(249, 115, 22, 0.4);',
    '}',
    '.copy:hover { background: #EA580C; }',
    '.copy.done { background: #16A34A; box-shadow: 0 2px 6px rgba(22, 163, 74, 0.4); }',
    '.note { font-size: 11px; color: #C2410C; margin-top: 2px; }',
    '@media (prefers-color-scheme: dark) {',
    '  .card { background: #0F1D22; color: #E2E8F0; border-color: #134E4A; }',
    '  .snippet { background: #112A2A; color: #99F6E4; border-color: #134E4A; }',
    '  .target { color: #7DD3FC; }',
    '  .label { color: #2DD4BF; }',
    '}'
  ].join('\n');

  function ensureHost(doc) {
    if (host && host.isConnected) return;
    host = doc.createElement('div');
    host.setAttribute('data-link-lens', 'card-host');
    host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;';
    shadow = host.attachShadow({ mode: 'open' });
    var style = doc.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    doc.documentElement.appendChild(host);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  function hide() {
    if (!shadow) return;
    var existing = shadow.querySelector('.card');
    if (existing) existing.remove();
  }

  /**
   * Show the card for one suggestion, anchored near the clicked span.
   * suggestion: { anchorText, url, matchType, inHeading }
   */
  function show(suggestion, span) {
    var doc = span.ownerDocument;
    ensureHost(doc);
    hide();

    var snippetHtml = '<a href="' + escapeAttr(suggestion.url) + '">' +
      escapeHtml(suggestion.anchorText) + '</a>';

    var card = doc.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="head">' +
      '  <span class="title">Link Lens' +
      '    <span class="badge ' + (suggestion.matchType === 'exact' ? 'exact' : 'loose') + '">' +
             suggestion.matchType + ' match</span>' +
      (suggestion.inHeading ? '<span class="badge heading">in heading</span>' : '') +
      '  </span>' +
      '  <button class="close" type="button" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="body">' +
      '  <div class="row"><div class="label">Suggested anchor text</div>' +
      '    <div class="anchor">' + escapeHtml(suggestion.anchorText) + '</div>' +
      (suggestion.inHeading ? '<div class="note">In heading — prefer a body occurrence.</div>' : '') +
      '  </div>' +
      '  <div class="row"><div class="label">Target URL</div>' +
      '    <div class="target">' + escapeHtml(suggestion.url) + '</div>' +
      '  </div>' +
      '  <div class="row"><div class="label">HTML snippet</div>' +
      '    <code class="snippet">' + escapeHtml(snippetHtml) + '</code>' +
      '    <button class="copy" type="button">Copy HTML</button>' +
      '  </div>' +
      '</div>';

    // Position near the highlight (viewport-aware).
    var rect = span.getBoundingClientRect();
    var top = rect.bottom + (doc.defaultView.scrollY || 0) + 8;
    var left = rect.left + (doc.defaultView.scrollX || 0);
    var maxLeft = (doc.defaultView.scrollX || 0) + doc.defaultView.innerWidth - 360;
    card.style.top = top + 'px';
    card.style.left = Math.max(8, Math.min(left, maxLeft)) + 'px';

    card.querySelector('.close').addEventListener('click', hide);
    var copyBtn = card.querySelector('.copy');
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(snippetHtml).then(function () {
        copyBtn.textContent = '✓ Copied';
        copyBtn.classList.add('done');
        setTimeout(function () {
          copyBtn.textContent = 'Copy HTML';
          copyBtn.classList.remove('done');
        }, 1600);
      }).catch(function () {
        // Clipboard API can be blocked; fall back to a selectable prompt.
        doc.defaultView.prompt('Copy the snippet below:', snippetHtml);
      });
    });

    shadow.appendChild(card);
  }

  function destroy() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
  }

  ns.card = { show: show, hide: hide, destroy: destroy };
})(self.__linkLens = self.__linkLens || {});
