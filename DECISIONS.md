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

## Intelligence layer (2.0.0)

- **Crawler runs in an offscreen document**, not the service worker (no DOMParser
  there) and not a content script (dies on navigation). A 1-minute watchdog alarm
  resumes an interrupted crawl; state persists every 8 pages so nothing is lost.
- **The site root is always crawled**, even when absent from the sitemap — hub
  pages carry the most editorial links and would otherwise be missing from the graph.
- **Only editorial links count** toward inbound/orphan/anchor stats: links inside
  `nav`, `footer`, `aside`, `header` or `role=navigation|banner|contentinfo` are
  boilerplate and would make every page look well-linked.
- **Targets with unusable slugs are kept** in the index (previously dropped) so a
  later crawl can give them title/topic match phrases.
- **Document-frequency table prunes singleton terms** past 40k entries — they carry
  no comparative signal (idf treats unknown terms as rare anyway) and would
  otherwise dominate storage on large sites.
- **Score weights** (match 40 / relevance 25 / link need 20 / placement 10 /
  phrase source 5, minus a 10-point anchor over-use penalty) are heuristics tuned
  so an orphan page with strong topical overlap outranks a well-linked page with a
  coincidental keyword hit.
- Crawl fetches use `credentials: 'include'` so staging and auth-gated sites work.
- **Out-edges are stored as interned integer ids** (crawl schema v2), not URL
  strings — 40k edges cost ~200 KB instead of ~1.4 MB. `authority()` returns null
  on a v1 crawl rather than guessing, so old crawls degrade instead of lying.
- **PageRank**: damping 0.85, 25 iterations, dangling mass redistributed evenly,
  normalized to mean 1.0 so the number is readable without a reference point.
- **The site-wide plan re-fetches** rather than reusing crawl data: anchor
  placement needs real sentences, and storing full text for 2,000 pages would blow
  the storage budget many times over. It is therefore opt-in and rate-limited.
- **Plan guardrails**: ≤3 links per page AND ≤1 per ~200 words (a 400-word page
  gets 2, a tiny page gets 1), ≤5 new links per target, score floor 45. Per-target
  counts are rebuilt from existing rows on resume so caps survive a pause.
- **Click depth** is BFS from the homepage over editorial links only; unreachable
  crawled pages report Infinity (rendered as BURIED) rather than a fake number.
- **Cannibalization uses candidate generation, not O(N²)**: pages are indexed by
  their 8 most distinctive terms and only pages sharing one are compared. Terms
  held by more than 5% of the site are treated as themes, not duplicate signals.

## Keyword mapping, precision and site-wide keywords (2.3.0)

Feedback after real use: bulk audits stopped at 20 URLs, the keyword check
only looked at 20 pages, and anchor → URL mapping was too loose.

- **Every target carries one primary keyword** (`target.primary`): the slug
  phrase by default, replaced by the page's H1/title once crawled (minus the site
  name and edge stopwords, ≤6 words). That is the keyword the URL is optimized
  for, so it is what anchors should say or closely vary. It is shown on every
  suggestion ("target keyword: …") and exported as `target_keyword`.
- **Precision rules in the matcher**: single-word targets need a 4+ letter word
  that fewer than 30% of crawled pages contain (kills "account" → random URL on a
  bank site); loose matches must sit within 5 words (`spread ≤ 4`), partials
  within 4 and require the head keyword; anchors never start or end on a
  stopword; with ≥20 crawled pages, a non-exact match whose two pages share no
  topical vocabulary (cosine < 0.02) is dropped as coincidence.
- **Keyword → target picking** (`intel.pickTarget`) scores every target's
  phrases *and* its primary keyword by stem overlap (hits + coverage of the
  keyword + coverage of the phrase), so "apply for savings account" resolves to
  `/savings-account/apply` while "savings account" resolves to the parent page.
  Nothing is guessed when the best score is below 1.
- **Keyword variations** (`intel.keywordVariants`) are mined from the site,
  not invented: anchors already used for the target (minus "read more"-style
  junk), titles/H1s containing the keyword, related titles sharing a stem, and
  finally intent templates ("apply for {kw}", "{kw} online", "{kw} eligibility"
  …) that are labelled as unproven suggestions. Proven sources sort first;
  anchors longer than 6 words are dropped.
- **Bulk audit moved to the background worker** (planner mode `audit`): up to
  500 URLs, persisted and resumable, every opportunity per page reported (no
  per-page/per-target caps — an audit is not a plan). The old 20-URL cap was a
  politeness limit of the in-tab implementation, which died when the tab
  navigated; it was never a product decision.
- **Site-wide keyword check moved to the same worker** (mode `keywords`): checks
  every crawled page (falls back to the index; up to 2,000) for one or more
  comma-separated keywords, each with its own auto-picked or user-given target.
  Rows: `page_url, suggested_anchor, keyword, target_url, position, relevance,
  context_sentence`.
- The three modes keep separate storage keys (`ll_plan:`, `ll_audit:`,
  `ll_kwsite:`) so a bulk audit never overwrites a site plan. `maxPerTarget` for
  audits is a large finite number — `Infinity` becomes `null` in storage and
  would have blocked every link after a resume.
- Legacy in-tab bulk/keyword handlers (`LL_BULK_START`, `LL_KEYWORD_START`)
  remain in `content/main.js` for programmatic use; the panel no longer calls them.

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

- Max 500 URLs enforced in the popup (was 20 when the batch ran inside the tab —
  see 2.3.0 above); off-domain URLs are rejected before the run starts with a
  visible error rather than silently dropped.
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
