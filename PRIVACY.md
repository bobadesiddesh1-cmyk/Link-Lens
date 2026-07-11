# Privacy Policy — Link Lens

**Effective date:** July 11, 2026

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

## What we do NOT do

- We do not collect, store, or transmit personal information of any kind.
- We do not use analytics, telemetry, error reporting, or tracking pixels.
- We do not sell or transfer any data to third parties.
- We do not use or transfer data for advertising, creditworthiness, or lending
  purposes.
- The extension makes no network requests to any server other than the website
  open in your current tab.

## Permissions

- `activeTab` and `scripting` — used only when you click the extension and press
  Scan, to run the scanner on that one tab.
- `storage` — used for the local, on-device cache described above.

The extension requests no host permissions and runs nothing in the background on
any website.

## Changes

If a future version of Link Lens changes any of the above, this policy will be
updated in the extension's repository and the Chrome Web Store listing before that
version is published.

## Contact

Questions about this policy can be raised via the issue tracker of the extension's
code repository: https://github.com/bobadesiddesh1-cmyk/Link-Lens/issues
