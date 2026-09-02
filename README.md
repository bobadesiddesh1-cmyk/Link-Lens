# 🔍 Link Lens — Internal Linking Opportunity Finder

Open any page of a site you manage and Link Lens highlights, **inline**, the exact
sentences that should link to other pages of that site — with suggested anchor text
and target URL. Works on **any CMS** (unlike WordPress-only plugins). 100% local
analysis; the only thing it ever fetches is **your own site's sitemap and pages**.

Built with Manifest V3, vanilla JS, no frameworks, no build step.

---

## Install (load unpacked)

1. Download / clone this folder.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. Pin **Link Lens** to the toolbar. Open any page of your site and click the icon —
   Link Lens opens in **Chrome's side panel**, staying open while you browse. It
   follows you across tabs; if Chrome asks for a fresh grant after a tab switch,
   just click the toolbar icon once on that tab.

No account, no configuration, no remote services.

---

## How it works

### 1. Site index (first scan of a domain)

On the first scan, Link Lens builds an index of your site's URLs, fetched **from the
page's own context** so every request is same-origin:

**Sitemap fallback chain** (first hit wins):

1. `https://{origin}/sitemap.xml`
2. `https://{origin}/sitemap_index.xml`
3. `https://{origin}/wp-sitemap.xml`
4. `https://{origin}/sitemap-index.xml`
5. `Sitemap:` lines inside `https://{origin}/robots.txt`

**Sitemap index files** are recursed one level: up to **8 child sitemaps** are
fetched (most recent by `<lastmod>` first). The total URL cap is **2,000**, keeping
the most recent by `<lastmod>` when present. `.xml.gz` entries are skipped and the
count is reported in the panel ("N compressed sitemaps skipped") — regular gzip
`Content-Encoding` is fine because the browser decompresses it transparently.

**No sitemap at all?** Link Lens drops into **shallow mode**: the index becomes all
same-origin `<a href>` URLs found on the current page, and the panel/popup label the
results as shallow.

For each indexed URL, the **target phrase** is derived from the slug (last path
segment): split on `-`/`_`, drop stopwords (60+ entry list), drop tokens shorter
than 3 chars, drop pure numbers, keep a 1–4 token phrase.
`/blog/keyword-research-guide-2024/` → phrase **"keyword research guide"**.

The index is cached in `chrome.storage.local` **per origin for 24 hours**; the popup
has a **Rebuild index** button to refresh it on demand.

### 2. Opportunity matching

- Main content is extracted (`<article>` / `<main>` / largest text block), excluding
  nav, footer, sidebar, and the text of existing links.
- Words and slug tokens are **stemmed**, so "researching keywords" matches a
  `keyword-research` page, and site identity is **www/scheme tolerant**, so a
  sitemap listing `www.example.com` still works while you browse `example.com`.
- Every indexed target (except the current page and its canonical) is scanned for:
  - **exact match** — the whole phrase, consecutive stems, case-insensitive; else
  - **loose match** — all phrase tokens within a **12-word window**, any order; else
  - **partial match** — for 3+ token slugs, all but one token in the window,
    and the slug's head keyword must be among them.
- Phrases may cross inline tags (`keyword <em>research</em>`) but never cross a
  block boundary. Matches inside existing `<a>` tags are skipped. A first
  occurrence inside a heading is allowed but flagged **"in heading — prefer body"**.
- If the page **already links** to a target anywhere (any locale/URL variant of
  it), that target is excluded and listed under **"already linked ✓"**.
- Locale-duplicate sitemap entries (`/zh-cn/post` next to `/post`) collapse into
  the original; generic single-word pages (`/about/`, `/contact/`) are never
  suggested; one suggestion per anchor phrase and per text span.
- **Precision rules** (2.3.0): single-word targets need a specific 4+ letter word
  that fewer than 30% of the site's pages contain; loose matches must sit within
  5 words and partials within 4; anchors never start or end on a stopword; once
  20+ pages are crawled, a non-exact match between two pages that share no topical
  vocabulary is dropped as coincidence.
- **Keyword map:** every target URL has one **primary keyword** — its slug phrase,
  replaced by its H1/title once crawled — shown on each suggestion ("target
  keyword: …") and exported as `target_keyword`, so anchors say (or closely vary)
  what the URL is actually optimized for.
- Capped at **30 suggestions**, ranked by score (with a crawl) or exact > loose >
  partial, then shallower target depth first.

**Performance:** target token sets are precompiled into an inverted index
(first token → candidate targets), so a 2,000-target × 5,000-word page is a single
sweep over the words — well under 400 ms.

### 3. Inline highlights, card, panel

- Candidate anchors are highlighted (green `#22C55E` @ 20% background, solid
  underline) with **non-destructive** span wrapping. A restore registry keeps every
  original text node, so **Clear restores the DOM exactly**.
- Click a highlight → a Shadow-DOM card with the suggested anchor text, target URL,
  match type, and a copy-ready `<a href="URL">anchor</a>` snippet with a Copy button.
- The Shadow-DOM side panel shows the summary count, all suggestions (click →
  scroll + pulse), the "already linked" list, and **Export CSV**:
  `source_url, anchor_text, target_url, target_keyword, target_title, score,
  match_type, position, target_inbound_links, reasons, context_sentence`
  — your client-deliverable (`position` = early / body / deep in the copy).

### 4. Site intelligence (crawl)

Popup → **Site intel** tab: crawl every URL in the sitemap (100 / 500 / all, at
1–4 pages per second) to build a local model of the site. The crawl runs in an
**offscreen document**, so it survives tab switches, navigation and even a
service-worker restart (a watchdog alarm resumes it), and it can be paused and
resumed. Per page it stores a compact profile — title, H1, meta description, word
count and top TF-IDF terms — plus the **editorial** internal link graph (nav and
footer boilerplate links are deliberately excluded) and anchor-text usage.

That model upgrades everything downstream:

- **Content-derived match phrases** — a target whose slug is useless
  (`/p/1234/`) is matched by its title and distinctive topic phrases instead.
- **Opportunity score (0–100)** on every suggestion = match quality + topical
  relevance (TF-IDF cosine between the two pages) + how badly the target needs
  links + placement − anchor over-use penalty. Suggestions are ranked by it and
  each one explains itself ("orphan page — no internal links", "strong topical
  overlap", "anchor X already used on 80% of links here — vary it").
- **Orphan pages** — sitemap pages with zero editorial inbound links.
- **Link equity report** — every page ranked by inbound internal links.
- **Anchor diversity audit** — targets whose inbound anchors are over-optimized.
- **Internal authority (PageRank)** — computed over editorial links only and
  normalized so the average page scores 1.00; a page at 0.20 receives a fifth of
  an average page's internal authority. Included in the link-equity CSV.
- **Keyword cannibalization** — pairs of pages whose topic vectors are near
  identical (≥ 72% similarity), i.e. two of your pages competing for the same
  query, with each one's inbound link count so you know which to consolidate into.

- **Click depth** — breadth-first distance from the homepage over editorial
  links; pages 4+ clicks deep (or unreachable) are flagged BURIED.

**Site-wide link plan.** The same tab can build the full deliverable: it re-reads
every crawled page and writes a complete *"add this link, on this page, with this
anchor"* plan for the entire site, as one CSV. Editorial guardrails are built in —
at most 3 new links per page and never more than 1 per ~200 words, at most 5 new
links pointing at any single target (so equity spreads instead of piling up), a
minimum score floor, and targets a page already links are excluded. It runs in the
background, is pausable and resumable, and survives a service-worker restart.
Re-fetching is required because placing an anchor needs each page's real
sentences, which the crawl deliberately does not store.

Extra CSVs ship from this tab: link equity (with an ORPHAN flag) and anchor
diversity. The whole model lives in `chrome.storage.local` — a 2,000-page crawl
is roughly 2–4 MB — and nothing leaves the browser.

### 5. Keyword mode

Panel → **Keyword** tab: enter one or **more keywords, comma-separated** (and
optionally the URL they should link to — otherwise the best-matching page is
auto-picked **per keyword** from the site index, using each page's primary
keyword). Three things you can do with them:

- **💡 Suggest keyword variations** — an intelligence layer that proposes anchor
  variations for each keyword, mined from your own site: anchors already used for
  the target, page titles containing the keyword ("Apply for Savings Account
  Online"), related titles sharing a stem ("current account"), and clearly
  labelled intent templates ("apply for savings account", "savings account
  online", "savings account eligibility"). Click a chip to add it to the list.
- **🔦 Highlight on the current page** — every spot on this page that mentions
  any of the keywords and doesn't link its target yet, colour-highlighted inline.
- **Check the whole site** — runs in the background over **every crawled page**
  (falls back to the index; up to 2,000 pages, resumable) and lists every page
  that **mentions a keyword but doesn't link the target yet** — with suggested
  anchor, placement, relevance and context, as one CSV. This is the "where should
  I add links to my money pages?" workflow.

### 6. Bulk mode

Panel → **Bulk audit** tab: paste up to **500 URLs of the same domain**. The batch
runs in the background worker (same engine as the site-wide plan), fetching
same-origin at the speed set on the Site intel tab, parsing off-DOM with
`DOMParser` and running the full scorer. Every opportunity on every page is
reported — no per-page or per-target caps, because an audit is not a plan. You can
close the panel and come back; the run is persisted and resumable. Per-URL failures
(404s, timeouts) are counted without aborting the batch, and the result is **one
combined 11-column CSV**.

---

## Why Link Lens needs (almost) no permissions

Declared permissions: `storage`, `activeTab`, `scripting`. **Host permissions: none.**

This is a deliberate design, and it's why the extension sails through review:

- Nothing is injected into any page until **you** click the extension and press
  Scan (`activeTab` grants access to that one tab, at that one moment).
- The sitemap fetch and all bulk-mode page fetches are performed **from the content
  script running in the page**, so they are **same-origin requests to the site
  you're already on** — no CORS exemptions, no `<all_urls>`, no broad host access.
- There are **no external requests, ever** — no analytics, no telemetry, no CDN.
  The only network traffic is your own site's sitemap and (in bulk mode) your own
  site's pages.

---

## File structure

```
link-lens/
├── manifest.json           # MV3; per-site host access granted on first use
├── background.js           # side panel, offscreen worker lifecycle, run routing
├── crawler/
│   ├── offscreen.html      # offscreen document (DOMParser lives here)
│   ├── crawler.js          # sitemap crawl → page profiles + editorial link graph
│   └── planner.js          # background engine: plan / audit / keywords modes
├── content/
│   ├── sitemap.js          # fallback chain, index recursion, caps
│   ├── indexer.js          # slug → phrase targets, shallow mode
│   ├── matcher.js          # content extraction + inverted-index matching
│   ├── highlighter.js      # non-destructive wrap + exact-restore registry
│   ├── card.js             # Shadow DOM suggestion card + copy snippet
│   ├── panel.js            # Shadow DOM side panel + CSV export
│   └── main.js             # in-tab orchestrator (scan, keyword-here, reports)
├── popup/
│   ├── popup.html          # side panel: scan / bulk / keyword / site intel
│   ├── popup.css
│   └── popup.js
├── shared/
│   ├── tokenizer.js        # slug tokenization, stopwords, URL normalization
│   ├── textstats.js        # TF-IDF, cosine, heading phrases
│   ├── intel.js            # keyword map, scoring, variants, PageRank, reports
│   ├── storage.js          # per-origin cache, 24 h TTL
│   └── csv.js              # RFC 4180 escaping + download
├── icons/                  # generated by make_icons.py (committed)
├── DECISIONS.md            # every unspecified choice, logged
└── README.md
```

---

## Acceptance tests (verified walkthrough)

1. **Load unpacked → zero console errors.** The manifest declares only the popup,
   background worker, and icons; nothing runs until you scan. Check the service
   worker console and the page console after a scan: clean.
2. **Scan a blog post on a site with a sitemap** → the popup streams index-build
   progress, green highlights appear in the article body, clicking one opens the
   card with anchor + target + copyable HTML, the side panel lists every
   suggestion, and Export CSV downloads the five-column report.
3. **"Already linked" exclusion** → any target the page already links to (anywhere
   in the document, any URL form — relative, trailing slash, `#fragment`) appears
   under "already linked ✓" and is never suggested or highlighted.
4. **Sitemap INDEX file** → child sitemaps are fetched newest-first, max 8, and the
   2,000-URL cap keeps the most recent by `<lastmod>`; the panel notes when the cap
   was applied and how many `.xml.gz` children were skipped.
5. **Site with no sitemap** → all four sitemap paths and robots.txt fail → shallow
   mode builds the index from same-origin links on the page; the panel and popup
   both label it "shallow mode".
6. **Clear highlights** → the restore registry re-inserts every original text node
   and removes every wrapper — the DOM (including text-node boundaries) is
   byte-identical to the original. Verify with a `MutationObserver` or by diffing
   `document.body.innerHTML` before scan and after Clear.
7. **Bulk: 5 URLs pasted** → the background run reports progress in the panel; if
   one URL 404s it is counted as failed and the batch continues; the combined CSV
   contains per-URL rows for the other four. Close and reopen the panel mid-run:
   progress is restored.
8. **Keyword: "savings account, apply for savings account"** → variations chips
   appear (site-mined first, templates last); "Check the whole site" walks every
   crawled page and the CSV lists one row per keyword per placement, each with its
   own target URL.

---

## Web Store listing draft

**Name:** Link Lens — Internal Linking Opportunity Finder

**Summary (132 chars):**
See exactly which sentences on your page should link to your other pages — inline
highlights, anchor text, and a CSV export.

**Description:**

Internal links are the cheapest SEO win there is — and the most tedious to find.
Link Lens does the finding for you, on any CMS.

Open a page of your site, click Scan, and Link Lens:

🔍 builds an index of your site from its sitemap (WordPress, Shopify, Webflow,
Hugo, custom — anything with a sitemap; shallow fallback if there isn't one)

🟢 highlights the exact sentences that should link to your other pages

✍️ suggests the anchor text and gives you a copy-ready HTML snippet

📊 exports a client-ready CSV: source URL, anchor text, target URL, match type,
and the full context sentence

📦 bulk mode: paste up to 500 URLs and get one combined report

💡 keyword mode: comma-separated keywords, site-mined anchor variations, and a
site-wide check of every page that should link your money pages

Privacy: 100% local analysis. Link Lens fetches only your own site's sitemap and
pages, requires no host permissions, and sends nothing anywhere. No account. No
analytics. No nonsense.

**Category:** Developer Tools / SEO
**Language:** English

---

## Palette

Deep Ocean + Sunset: teal `#0D9488` → cyan `#06B6D4` gradients with coral `#F97316`
calls-to-action; highlight green `#22C55E` for matches. Dark-mode aware everywhere
(popup, panel, card) via `prefers-color-scheme`.
