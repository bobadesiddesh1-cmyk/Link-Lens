# Privacy Policy — Link Lens

**Effective date:** September 2, 2026

Link Lens ("the extension") is a browser extension that finds internal linking
opportunities on the website you are currently viewing. This policy explains what
data the extension handles. The short version: **Link Lens collects no personal
data, transmits nothing to us or to any third party, and contains no analytics or
tracking of any kind.**

## What the extension does with data

- **Page content.** When you click Scan, the extension reads the text of the page
  in your current tab in order to highlight sentences that could link to other
  pages of the same website. This analysis happens entirely inside your browser.
  Page content is never transmitted, stored remotely, or shared.
- **Your site's sitemap.** To learn which pages exist on the site, the extension
  fetches the site's own public sitemap (e.g. `sitemap.xml` or the sitemap listed
  in `robots.txt`). These requests go only to the website you are already viewing —
  never to any other server.
- **Local cache.** The list of URLs derived from the sitemap, and the progress of a
  bulk audit you start, are cached on your device using Chrome's `storage.local`
  API (for up to 24 hours per site). This cache never leaves your device and can be
  cleared at any time by removing the extension or using its "Rebuild index"
  button.
- **CSV export.** Reports you export are generated locally and saved as a download
  by your browser. They are not uploaded anywhere.
- **Google Search Console (optional, off by default).** If — and only if — you
  click "Connect Google Search Console", the extension asks you to sign in with
  Google and grants itself read-only access to Search Console
  (`webmasters.readonly`). It then reads, for the site you are working on, the
  search queries and the pages they lead to over the last 90 days, and stores an
  aggregate of that on your device. This is used to map keywords to the pages
  that already rank for them and to prioritise link opportunities.

  - The sign-in is handled by Chrome itself; the access token is held in Chrome's
    own token store, not by us.
  - The data travels directly from Google to your browser. **There is no Link
    Lens server**, so it cannot pass through one.
  - We never read your Search Console data, and it is never shared with anyone.
  - You can revoke it at any time with the **Disconnect** button, which deletes
    the stored data and revokes the token with Google. You can also remove access
    at https://myaccount.google.com/permissions.
  - Nothing is ever written back to Search Console — the access is read-only.

## What we do NOT do

- We do not collect, store, or transmit personal information of any kind.
- We do not use analytics, telemetry, error reporting, or tracking pixels.
- We do not sell or transfer any data to third parties.
- We do not use or transfer data for advertising, creditworthiness, or lending
  purposes.
- The extension makes no network requests to any server other than the website
  open in your current tab and, if you explicitly connect it, Google's own
  Search Console API on your behalf.

## Permissions

- `activeTab` and `scripting` — used only when you click the extension and press
  Scan, to run the scanner on that one tab.
- `storage` — used for the local, on-device cache described above.
- `sidePanel`, `tabs` — to show the panel and follow the tab you are on.
- `offscreen`, `alarms` — to run an optional site crawl of your own site in the
  background and resume it if the browser interrupts it.
- `identity` — used ONLY if you choose to connect Google Search Console. Without
  that click it is never exercised.

The extension declares no mandatory host permissions. Access to a website, and
access to `googleapis.com` for Search Console, are optional permissions you grant
per site, on request, and can revoke at any time.

## Changes

If a future version of Link Lens changes any of the above, this policy will be
updated in the extension's repository and the Chrome Web Store listing before that
version is published.

## Contact

Questions about this policy can be raised via the issue tracker of the extension's
code repository: https://github.com/bobadesiddesh1-cmyk/Link-Lens/issues
