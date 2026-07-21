# DECISIONS.md — Link Lens

Choices that were genuinely unspecified in the brief, and how they were resolved.
Everything else follows the brief verbatim.

## Design language

- **Brand palette: "Deep Ocean + Sunset" — teal/cyan primary (`#0D9488` → `#06B6D4`
  gradient) with a warm coral/amber accent (`#F97316` / `#FBBF24`).** Deliberately NOT
  purple. High-energy, high-contrast, and distinct from both Claude-purple and the sea
  of blue SEO tools. Highlight color for matched text stays the spec-mandated green
  `#22C55E` @ 20% background with a solid underline.
- Dark mode is detected with `prefers-color-scheme` inside every Shadow DOM stylesheet
  (panel, card) and in the popup CSS. Colors were checked for ≥ 4.5:1 contrast on both
  themes.

## Architecture

- **Content scripts are injected programmatically** (`chrome.scripting.executeScript`
  with `activeTab`), not declared in the manifest. Nothing runs on any page until the
  user clicks the extension and presses Scan. This is why the extension needs zero host
  permissions.
- **Script format: classic scripts sharing a `window.__linkLens` namespace**, injected
  in dependency order (shared → content modules → main). ES modules can't be injected
  as a plain file list with `executeScript`, and a build step is forbidden by the brief.
  A `window.__linkLensInjected` guard makes injection idempotent.
- **Bulk mode runs entirely in the active tab's content-script context** (same-origin
  fetch + `DOMParser`, off-DOM matching). `background.js` only orchestrates: it relays
  start/cancel, buffers progress + results in `chrome.storage.local` so the popup can
  close and reopen mid-batch without losing the run.
- **Popup ↔ tab ↔ background message contract** (single source of truth, used
  everywhere):
  - popup → tab: `LL_PING`, `LL_SCAN {force}`, `LL_REBUILD`, `LL_CLEAR`, `LL_STATUS`,
    `LL_BULK_START {urls}`, `LL_BULK_CANCEL`
  - tab → runtime: `LL_PROGRESS {stage, message}`, `LL_SCAN_DONE {summary}`,
    `LL_BULK_PROGRESS {done, total, url, ok, error, found}`, `LL_BULK_DONE {rows, failures}`
  - background persists the latest bulk state under `ll_bulk:{origin}`.

## Sitemap / indexing

- **`<lastmod>` missing:** URLs without `lastmod` sort *after* URLs that have one when
  the 2,000-URL cap forces trimming (spec says "keep most recent by lastmod when
  present"; absent = unknown = lowest priority). Among themselves they keep document
  order.
- **Child-sitemap selection when an index has > 8 children:** children are sorted by
  their own `<lastmod>` (descending, missing last) and the first 8 are fetched.
- **robots.txt `Sitemap:` lines** are only honored if same-origin (cross-origin
  sitemap URLs are skipped and logged) — the "no external requests" rule wins.
- **Homepage / empty slugs:** an indexed URL whose last path segment produces zero
  usable tokens (e.g. `/`, `/2024/`, `/x/`) is dropped from the target set — there is
  no phrase to match.
- **Slug phrase length:** slugs yielding more than 4 tokens keep the **first 4**
  (slugs normally lead with the head keyword; trailing tokens are usually ids/dates).
- **Depth** = number of non-empty path segments of the target URL.
- **Sitemap fetch timeout:** 10 s per request via `AbortController`, so a hanging
  sitemap can't wedge a scan.

## Matching engine v2 (1.1.0)

v1 matched exact word forms only, required every slug token, keyed the inverted
index on the first token only, and treated `www.example.com` sitemap URLs as
cross-origin — which produced zero results on most real sites. v2 (validated
against live blog.cloudflare.com and css-tricks.com articles):

- **Light stemming** (plurals, -ies/-y, -ing, -ed, trailing -e, y→i) applied to
  both slug tokens and page words.
- **www/scheme-tolerant site identity** (`siteKey`) everywhere: sitemap
  discovery, target filtering, self-exclusion, already-linked detection.
- **Inverted index keyed by every token**, not just the first.
- **Match types**: exact (consecutive stems) > loose (all tokens in a 12-word
  window) > partial (n-1 of n tokens for n ≥ 3, head keyword required).
- **Phrases may cross inline tags** (em/strong/span) but never block boundaries;
  the highlighter wraps one segment per text node.
- **Noise controls**: generic single-word targets dropped (/about/ etc.);
  multi-word slugs that degrade to one token dropped ("ai-platform" → "platform");
  locale-prefixed duplicates collapse to the original (before the 2,000 cap, and
  lastmod ties break toward shorter URLs); one suggestion per anchor phrase; one
  suggestion per text span.
- Index cache carries a version number; older caches rebuild automatically.

## Matching

- **Matches are constrained to a single DOM text node.** Slug phrases are 1–4 words;
  a phrase split across element boundaries (e.g. `<em>`) is a rare edge case, and
  single-node matches let Clear restore the DOM byte-for-byte via the node registry.
  Loose (windowed) matches are likewise evaluated within one text node.
- **Word boundaries:** tokens match on Unicode-letter/digit boundaries
  (`[\p{L}\p{N}]+` word extraction), case-insensitive via `toLowerCase()`.
- **"Best match" tie-break beyond the spec** (exact > loose, earliest): a body match
  beats a heading match of the same type, since headings are flagged "prefer body"
  anyway.
- **URL normalization for "already linked" / self-exclusion:** strip hash, strip
  query, lowercase host, collapse trailing slash, resolve relative hrefs against the
  page URL. `<link rel="canonical">` of the current page is excluded like the page URL
  itself.
- **Loose-match anchor text** = the span of page text from the first to the last
  matched token inside the 10-word window (what an editor would actually anchor).

## Bulk mode

- Max 20 URLs enforced in the popup; off-domain URLs are rejected before the run
  starts with a visible error rather than silently dropped.
- Per-URL failures (404, network, timeout, non-HTML content-type) are recorded as a
  `failures` list and shown in the popup + appended to the CSV as comment-free extra
  columns? **No** — failures are NOT written into the CSV (it's a client deliverable);
  they are listed in the popup UI only.
- Rate limit: 1 fetch/second (1,000 ms gap between request *starts*).
- The current page can be included in the pasted list; it is fetched fresh like any
  other URL for consistency.

## CSV

- `context_sentence` = the sentence containing the match, extracted by splitting on
  `.!?` followed by whitespace/EOL; trimmed to ≤ 300 chars around the match if the
  "sentence" is a wall of text.
- RFC 4180 escaping: any field containing `"`, `,`, `\n`, or `\r` is quoted, inner
  quotes doubled. A UTF-8 BOM is prepended so Excel opens it correctly.

## Icons

- Generated at build-author time by `icons/make_icons.py` (pure-stdlib PNG writer,
  committed for reproducibility) — **two interlocked chain links** on a transparent
  background: back link in the teal→cyan gradient, front link in coral→amber, with a
  cut-gap weave. Deliberately NOT the generic "glyph in a rounded square" template.
  The same mark is inlined as SVG in the side panel and shown via `icon48.png` in the
  popup header. The PNGs are committed; the script is not needed at runtime and is
  not referenced by the manifest.

## Misc

- Index cache TTL: 24 h from build time, per origin (`ll_index:{origin}` in
  `chrome.storage.local`). "Rebuild index" bypasses and overwrites the cache.
- Suggestions cap (30) applies after ranking; the panel states when the cap was hit.
- Shallow mode (no sitemap found) derives targets from same-origin `<a href>` URLs on
  the current page, deduped, capped at 2,000, and is labeled in the panel and popup.
