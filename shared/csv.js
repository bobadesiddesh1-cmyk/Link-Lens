/**
 * Link Lens — shared/csv.js
 * RFC 4180 CSV building + download helper. Pure except for the download
 * function (which needs a DOM). Escapes commas, quotes and newlines.
 */
(function (ns) {
  'use strict';
  if (ns.csv) return; // idempotent re-injection guard

  /** Escape one field per RFC 4180. Always safe for Excel/Sheets. */
  function escapeField(value) {
    var s = value == null ? '' : String(value);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * rows: array of arrays. header: array of column names.
   * Returns a CSV string with CRLF line endings and a UTF-8 BOM
   * (so Excel detects the encoding).
   */
  function build(header, rows) {
    var lines = [];
    lines.push(header.map(escapeField).join(','));
    for (var i = 0; i < rows.length; i++) {
      lines.push(rows[i].map(escapeField).join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  /** Trigger a client-side download of a CSV string (DOM contexts only). */
  function download(filename, csvString, doc) {
    var d = doc || document;
    var blob = new Blob([csvString], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = d.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    d.body.appendChild(a);
    a.click();
    setTimeout(function () {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1000);
  }

  /**
   * Ahrefs "Link opportunities" export format: TAB separated, EVERY field
   * quoted (numbers included), CRLF line endings, UTF-16 LE with BOM.
   * Matching it byte-for-byte means the file drops straight into the
   * workbooks the team already uses instead of being reshaped by hand.
   */
  function buildTsv(headers, rows) {
    var q = function (v) {
      return '"' + String(v == null ? '' : v).replace(/"/g, '""')
        .replace(/[\r\n]+/g, ' ') + '"';
    };
    var out = [headers.map(q).join('\t')];
    for (var i = 0; i < rows.length; i++) out.push(rows[i].map(q).join('\t'));
    return out.join('\r\n') + '\r\n';
  }

  /** Download `text` as UTF-16 LE with a BOM (what Ahrefs emits). */
  function downloadUtf16(filename, text, doc) {
    var units = new Uint16Array(text.length + 1);
    units[0] = 0xFEFF; // BOM
    for (var i = 0; i < text.length; i++) units[i + 1] = text.charCodeAt(i);
    var blob = new Blob([units.buffer], { type: 'text/tab-separated-values' });
    var d = doc || document;
    var url = URL.createObjectURL(blob);
    var a = d.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    d.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  ns.csv = {
    buildTsv: buildTsv,
    downloadUtf16: downloadUtf16,
    escapeField: escapeField,
    build: build,
    download: download
  };
})(self.__linkLens = self.__linkLens || {});
