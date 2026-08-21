/**
 * Link Lens — content/panel.js
 * Side panel (Shadow DOM): summary, suggestion list (click → scroll +
 * pulse), "already linked ✓" list, index-status notes, Export CSV.
 * Palette: Deep Ocean teal/cyan + Sunset coral. Dark-mode aware.
 */
(function (ns) {
  'use strict';
  if (ns.panel) return; // idempotent re-injection guard

  var host = null;
  var shadow = null;

  // Inline brand mark (interlocked links) — matches icons/make_icons.py.
  var LOGO_SVG =
    '<svg class="mark" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">' +
    '<defs>' +
    '<linearGradient id="llg1" x1="0" y1="48" x2="48" y2="0" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#0A7A70"/><stop offset="1" stop-color="#22D3EE"/></linearGradient>' +
    '<linearGradient id="llg2" x1="0" y1="48" x2="48" y2="0" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#EA580C"/><stop offset="1" stop-color="#FBBF24"/></linearGradient>' +
    '<mask id="llcut"><rect width="48" height="48" fill="#fff"/>' +
    '<rect x="19.92" y="16.08" width="23.04" height="15.84" rx="7.92" fill="none" stroke="#000" ' +
    'stroke-width="8.88" transform="rotate(-45 24 24)"/></mask>' +
    '</defs>' +
    '<g fill="none" stroke-width="5.52">' +
    '<rect x="5.04" y="16.08" width="23.04" height="15.84" rx="7.92" stroke="url(#llg1)" ' +
    'mask="url(#llcut)" transform="rotate(-45 24 24)"/>' +
    '<rect x="19.92" y="16.08" width="23.04" height="15.84" rx="7.92" stroke="url(#llg2)" ' +
    'transform="rotate(-45 24 24)"/>' +
    '</g></svg>';

  var CSS = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; margin: 0; padding: 0; }',
    '.panel {',
    '  position: fixed; top: 12px; right: 12px; bottom: 12px;',
    '  width: 330px; max-width: calc(100vw - 24px);',
    '  z-index: 2147483645;',
    '  display: flex; flex-direction: column;',
    '  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
    '  font-size: 13px; line-height: 1.45; color: #0F172A;',
    '  background: #FFFFFF;',
    '  border: 1px solid #99F6E4; border-radius: 14px;',
    '  box-shadow: 0 16px 48px rgba(13, 148, 136, 0.28), 0 4px 12px rgba(15, 23, 42, 0.12);',
    '  overflow: hidden;',
    '}',
    '.head {',
    '  padding: 14px 16px;',
    '  background: linear-gradient(135deg, #0D9488 0%, #06B6D4 55%, #0EA5E9 100%);',
    '  color: #FFFFFF; flex: 0 0 auto;',
    '}',
    '.head .brand { display: flex; align-items: center; justify-content: space-between; }',
    '.head .name { font-weight: 800; font-size: 15px; letter-spacing: .02em;',
    '  display: inline-flex; align-items: center; gap: 8px; }',
    '.head .mark { background: rgba(255,255,255,0.92); border-radius: 6px; padding: 2px; }',
    '.head .count { font-size: 26px; font-weight: 800; margin-top: 4px; }',
    '.head .sub { font-size: 11px; opacity: .9; }',
    '.iconbtn {',
    '  background: rgba(255,255,255,0.18); border: 0; color: #fff; cursor: pointer;',
    '  width: 24px; height: 24px; border-radius: 7px; font-size: 14px; line-height: 1;',
    '}',
    '.iconbtn:hover { background: rgba(255,255,255,0.35); }',
    '.notes { padding: 8px 16px; background: #FFF7ED; color: #9A3412; font-size: 11px; flex: 0 0 auto; }',
    '.notes:empty { display: none; }',
    '.list { flex: 1 1 auto; overflow-y: auto; padding: 8px; }',
    '.sect { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em;',
    '  color: #0D9488; padding: 10px 8px 4px; }',
    '.item {',
    '  padding: 9px 10px; border-radius: 9px; cursor: pointer; margin-bottom: 4px;',
    '  border: 1px solid transparent;',
    '}',
    '.item:hover { background: #F0FDFA; border-color: #99F6E4; }',
    '.item .anchor { font-weight: 600; }',
    '.score { display: inline-block; min-width: 26px; text-align: center; font-size: 10px;',
    '  font-weight: 800; padding: 2px 5px; border-radius: 6px; margin-right: 6px; }',
    '.score.hi { background: #0D9488; color: #fff; }',
    '.score.mid { background: #CCFBF1; color: #0F766E; }',
    '.score.lo { background: #F1F5F9; color: #64748B; }',
    '.why { font-size: 10px; color: #64748B; margin-top: 3px; font-style: italic; }',
    '.item .url { font-size: 11px; color: #0369A1; word-break: break-all; margin-top: 2px; }',
    '.tag { display: inline-block; font-size: 9px; font-weight: 800; text-transform: uppercase;',
    '  letter-spacing: .05em; padding: 1px 7px; border-radius: 999px; margin-left: 6px; vertical-align: 1px; }',
    '.tag.exact { background: #DCFCE7; color: #15803D; }',
    '.tag.loose { background: #FEF3C7; color: #B45309; }',
    '.tag.partial { background: #E0F2FE; color: #0369A1; }',
    '.tag.early { background: #CCFBF1; color: #0F766E; }',
    '.tag.heading { background: #FFEDD5; color: #C2410C; }',
    '.linked { padding: 7px 10px; font-size: 12px; color: #475569; }',
    '.linked .url { font-size: 11px; color: #64748B; word-break: break-all; }',
    '.linked .check { color: #16A34A; font-weight: 700; margin-right: 4px; }',
    '.empty { padding: 24px 16px; text-align: center; color: #64748B; }',
    '.foot { flex: 0 0 auto; display: flex; gap: 8px; padding: 12px; border-top: 1px solid #CCFBF1; }',
    '.btn {',
    '  flex: 1; padding: 10px 12px; font-size: 12px; font-weight: 800; border-radius: 9px;',
    '  border: 0; cursor: pointer;',
    '}',
    '.btn.export { background: #F97316; color: #FFFFFF; box-shadow: 0 2px 8px rgba(249,115,22,.4); }',
    '.btn.export:hover { background: #EA580C; }',
    '.btn.clear { background: #F1F5F9; color: #334155; }',
    '.btn.clear:hover { background: #E2E8F0; }',
    '@media (prefers-color-scheme: dark) {',
    '  .panel { background: #0F1D22; color: #E2E8F0; border-color: #134E4A; }',
    '  .item:hover { background: #112A2A; border-color: #134E4A; }',
    '  .item .url { color: #7DD3FC; }',
    '  .sect { color: #2DD4BF; }',
    '  .notes { background: #2A1B0E; color: #FDBA74; }',
    '  .linked { color: #94A3B8; } .linked .url { color: #64748B; }',
    '  .empty { color: #94A3B8; }',
    '  .foot { border-top-color: #134E4A; }',
    '  .btn.clear { background: #1E293B; color: #CBD5E1; }',
    '  .btn.clear:hover { background: #334155; }',
    '}'
  ].join('\n');

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureHost(doc) {
    if (host && host.isConnected) return;
    host = doc.createElement('div');
    host.setAttribute('data-link-lens', 'panel-host');
    shadow = host.attachShadow({ mode: 'open' });
    var style = doc.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    doc.documentElement.appendChild(host);
  }

  /**
   * Render the panel.
   * data: { suggestions, alreadyLinked, capped, indexInfo, pageUrl }
   * handlers: { onFocus(id), onClear(), onExport() }
   */
  function render(doc, data, handlers) {
    ensureHost(doc);
    var old = shadow.querySelector('.panel');
    if (old) old.remove();

    var notes = [];
    if (data.indexInfo) {
      if (data.indexInfo.shallow) {
        notes.push('Shallow mode: no sitemap found — index built from same-origin links on this page.');
      }
      if (data.indexInfo.skippedGz > 0) {
        notes.push(data.indexInfo.skippedGz + ' compressed sitemap' +
          (data.indexInfo.skippedGz === 1 ? '' : 's') + ' skipped (.xml.gz not supported).');
      }
      if (data.indexInfo.capped) {
        notes.push('Site index capped at 2,000 URLs (most recent by lastmod kept).');
      }
    }
    if (data.capped) {
      notes.push('Showing the top 30 suggestions (more matches exist).');
    }

    var panel = doc.createElement('div');
    panel.className = 'panel';

    var sHtml = '';
    if (data.suggestions.length === 0) {
      sHtml = '<div class="empty">' +
        escapeHtml(data.diagnosis || 'No internal link opportunities found on this page.') +
        '<br><br>Try Rebuild Index in the popup if the site changed recently.</div>';
    } else {
      sHtml += '<div class="sect">Opportunities (' + data.suggestions.length + ')</div>';
      data.suggestions.forEach(function (s, id) {
        sHtml +=
          '<div class="item" data-id="' + id + '">' +
          (s.score != null
            ? '<span class="score ' + (s.score >= 70 ? 'hi' : (s.score >= 45 ? 'mid' : 'lo')) +
              '" title="opportunity score">' + s.score + '</span>'
            : '') +
          '  <span class="anchor">' + escapeHtml(s.anchorText) + '</span>' +
          '  <span class="tag ' + s.matchType + '">' + s.matchType + '</span>' +
          (s.inHeading ? '<span class="tag heading">heading</span>' : '') +
          (s.position === 'early' ? '<span class="tag early">early</span>' : '') +
          '  <div class="url">→ ' + escapeHtml(s.url) + '</div>' +
          ((s.reasons && s.reasons.length)
            ? '<div class="why">' + escapeHtml(s.reasons.join(' · ')) + '</div>' : '') +
          '</div>';
      });
    }

    var lHtml = '';
    if (data.alreadyLinked.length > 0) {
      lHtml += '<div class="sect">Already linked ✓ (' + data.alreadyLinked.length + ')</div>';
      data.alreadyLinked.forEach(function (t) {
        lHtml +=
          '<div class="linked"><span class="check">✓</span>' + escapeHtml(t.phrase) +
          '  <div class="url">' + escapeHtml(t.url) + '</div>' +
          '</div>';
      });
    }

    panel.innerHTML =
      '<div class="head">' +
      '  <div class="brand"><span class="name">' + LOGO_SVG + 'Link Lens</span>' +
      '    <button class="iconbtn" type="button" aria-label="Close panel">✕</button></div>' +
      '  <div class="count">' + data.suggestions.length + '</div>' +
      '  <div class="sub">internal link opportunit' + (data.suggestions.length === 1 ? 'y' : 'ies') +
      '    · ' + data.alreadyLinked.length + ' already linked</div>' +
      '</div>' +
      '<div class="notes">' + notes.map(escapeHtml).join(' · ') + '</div>' +
      '<div class="list">' + sHtml + lHtml + '</div>' +
      '<div class="foot">' +
      '  <button class="btn export" type="button">Export CSV</button>' +
      '  <button class="btn clear" type="button">Clear highlights</button>' +
      '</div>';

    panel.querySelectorAll('.item').forEach(function (el) {
      el.addEventListener('click', function () {
        handlers.onFocus(parseInt(el.getAttribute('data-id'), 10));
      });
    });
    panel.querySelector('.iconbtn').addEventListener('click', function () {
      panel.remove();
    });
    panel.querySelector('.btn.export').addEventListener('click', handlers.onExport);
    panel.querySelector('.btn.clear').addEventListener('click', handlers.onClear);

    shadow.appendChild(panel);
  }

  function destroy() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
  }

  ns.panel = { render: render, destroy: destroy };
})(self.__linkLens = self.__linkLens || {});
