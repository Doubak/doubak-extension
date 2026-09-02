# Doubak — back up your Douban account to a WARC archive

**[中文 README](README.md)** · English

[![test](https://github.com/Doubak/doubak-extension/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Doubak/doubak-extension/actions/workflows/test.yml?query=branch%3Amain) [![Coverage Status](https://coveralls.io/repos/github/Doubak/doubak-extension/badge.svg?branch=main)](https://coveralls.io/github/Doubak/doubak-extension?branch=main)

> **This is the source repository.** For what the project is and how to use it, see
> **<https://doubak.com>**. For what the output looks like, see
> **<https://sample.doubak.com>**.

Doubak (豆备) is a browser extension that backs up your [Douban](https://www.douban.com)
account — marks, ratings, short reviews, tags, broadcasts (广播), journals, reviews, your
own doulists, and the images you uploaded — by **archiving the pages themselves as
standard [WARC](https://iipc.github.io/warc-specifications/) files**, in your own browser,
from your own IP, at your own pace.

Then, without installing anything else, it turns that archive into **structured data**, a
**[NeoDB](https://neodb.social) import package**, or a **searchable static site that works
fully offline**.

Credentials and session cookies never leave your device. There is no server to leak them,
because there is no server. The acceptance test is literal: **turn every server off and the
extension still produces a complete, usable local archive.**

## Read this first

Two things an English-speaking reader should know before installing:

- **The user interface is in Simplified Chinese only.** There is no `_locales/`
  directory and no `default_locale`; the panel strings are hard-coded Chinese. The
  archive format, the exported data and the generated site are language-neutral, but
  operating the extension currently requires reading Chinese.
- **Chromium-only.** It needs the [File System Access
  API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
  (`showDirectoryPicker`) to write archives, and the extension `offscreen` API to run
  the crawl. Firefox and Safari have neither, so **it cannot be ported to them by
  publishing a listing** — the capture path and the export path would both need
  rewriting. Chrome and Edge are what it is tested on; other Chromium browsers
  (Brave, Vivaldi, Opera) should work but are not verified.

## Why this exists

Douban has no export. A decade of marks, ratings, short reviews, broadcasts and journals
lives in an account you can be logged out of at any time — and for overseas users whose
registration phone number has been disconnected, a single SMS verification is permanent
loss.

Most backup tools export a CSV or scrape the text. Once Douban's markup changes, an entry
is deleted, or an image 404s, what you kept can no longer reconstruct what you actually saw.
Archiving the page itself is what makes that reconstruction possible years later — and
deleted entries are not hypothetical: the sample archive contains **eight works Douban has
since removed** — seven games and one film. Their pages are gone; what was written about
them is not. Short reviews survive for seven of the eight, tags for six, and for three, the
star rating — frozen into a broadcast on the day it was posted, because a broadcast cannot
be edited afterwards.

That last point is the sharpest thing this archive can demonstrate, so it is worth being
exact about: **not one of the eight still carries a rating on the mark itself.** Douban
keeps only current state, and current state left with the entry. The stars that survive
survive because they were posted, not because they were stored.

What is *not* recoverable is what the works were called. Douban re-renders the work card
under a broadcast at the moment you open the page, so even a 2017 broadcast captured in
2026 already reads 「未知作品」. Three of the eight got their names back only because an
older 2022–2024 archive had seen them while they still existed. **A name survives only if
something captured it while the entry was still up** — which is the entire difference
between backing up now and getting to it later.

## Install

| | |
|---|---|
| Chrome Web Store | <https://chromewebstore.google.com/detail/hilmaopahndgbiolohgefnbeedobpafe> |
| Microsoft Edge Add-ons | <https://microsoftedge.microsoft.com/addons/detail/jfaancfhcbfebmlphapaifkpijlcgnpf> |
| Unpacked | [Releases](https://github.com/Doubak/doubak-extension/releases/latest) → `doubak-<version>.zip` |

Both stores carry the same package, built by the same CI run. The release zip is
byte-identical to it, but it is **the store submission format — browsers cannot install a
zip directly**: unzip it first, then `chrome://extensions` (or `edge://extensions`) →
Developer mode → "Load unpacked" → pick the unzipped directory.

There is no build step and there are no dependencies. The source in this repository is
exactly what runs in the browser, so loading the repo root as an unpacked extension also
works.

## What it captures

| Route | Status |
|---|---|
| Broadcasts (广播) | Supported |
| Mark lists — books, film/TV, music, games, theatre | Supported |
| Work detail pages | Supported, derived from list pages |
| Journals, book/film reviews | Supported, full text fetched separately from the truncated list excerpts |
| Images you uploaded | Supported — broadcast attachments and journal inline images, originals only |
| Work covers | Supported |
| Doulists (豆列) | Your own lists, including the per-item comments you wrote |
| Photo albums | Not yet — no sample available to validate against |
| Mobile-app pages | **Not supported.** Upstream removed them; work detail pages return 404 |

Broadcasts are the least replaceable route: they freeze at the moment you post, cannot be
edited, and leave **no trace at all** when deleted. If you want to try a small slice first,
start there.

The first run is a **full crawl** — a complete pass, resumable. Later runs are
**incremental**: they stop at the last item seen, and skip broadcasts, already-captured
work pages and images. The test is "can the upstream thing still change", not "have we
fetched it before", which is why incremental runs are fast enough to run often.

## What you get out

The archive is a plain folder of WARC segment files, an index, and a `manifest.json` — back
it up like any other folder. From it, the extension's export page produces:

- **Structured data** (canonical JSON) — one parse, reusable forever
- **A NeoDB import package** — NDJSON, verified end to end against a real NeoDB instance
- **A static site** — searchable, with stable permalinks, **fully readable offline**

Adapters for **Letterboxd** and **Goodreads** live in
[doubak-export-adapters](https://github.com/Doubak/doubak-export-adapters), as command-line
tools. Neither has been round-tripped against the real service yet, so the honest claim for
those two is "matches the format read out of the importer's source", not "works" — which is
also why the export page in the extension offers only NeoDB. A button is a claim that the
path works.

Because parsing is a pure function over already-captured pages, downstream formats can be
added years later without re-crawling anything. Capture is the only irreversible step.

## Compared with 豆伴 / tofu

[豆伴](https://github.com/doufen-org/tofu) predates this project by years and is how a lot
of people still have their Douban. The difference is what gets stored: **what was read off
the page, or the page itself.**

| | 豆伴 / tofu | Doubak |
|---|---|---|
| Stores | Parsed entries in the extension's own database | The pages as served, as WARC |
| Images | Not included — [its README](https://github.com/doufen-org/tofu) states the backup does not contain images and must be browsed online | Captured, including your uploads and work covers |
| Offline | Images will not load | Whole site readable, permalinks stable |
| Export | Excel spreadsheet | Structured data, NeoDB package, searchable static site |
| Browsers | Chromium only | **Chromium only, same as 豆伴** |

Note "豆坟" and "豆伴" are different things: 豆伴 is the extension, while 豆坟 is a
repackaged Chromium browser they ship so Windows users can install 豆伴 without the Chrome
Web Store. "豆坟 doesn't work" is usually about that browser, not about the backup.

If you want a browsable list you can pull into a spreadsheet, 豆伴 is the more direct tool.
What is added here — verbatim archiving, images, offline, stable permalinks — is for a
different question: **when an entry is deleted, what did the page actually say?**

## Privacy

No data collection, no uploads, no analytics, no cookies, no server. Host permissions are
limited to `*.douban.com` and `*.doubanio.com`. The full permission audit, including which
broader permissions were deliberately *not* requested and why, is in
[`docs/permissions.md`](docs/permissions.md).

## Project layout

| Repository | Role |
|---|---|
| [doubak-extension](https://github.com/Doubak/doubak-extension) | This one. Capture, and the whole downstream pipeline in the panel |
| [doubak-data-specs](https://github.com/Doubak/doubak-data-specs) | The archive format ([SPEC](https://github.com/Doubak/doubak-data-specs/blob/main/bundle/v1/SPEC.md)) |
| [doubak-export-adapters](https://github.com/Doubak/doubak-export-adapters) | canonical → NeoDB / Letterboxd / Goodreads |
| [doubak-import-adapters](https://github.com/Doubak/doubak-import-adapters) | Other tools' captures → this archive format |

## Development

`npm test` runs with zero install. With the optional dev dependencies, WARC output is
additionally validated against Webrecorder's `warcio`; with `doubak-data-specs` checked out
as a sibling directory, cross-repository consistency checks run too.

Node ≥ 20 for the optional tooling. Nothing is required to run the extension itself.

## Documentation

The Chinese documents are the canonical ones and go into far more depth than this page:

- [`README.md`](README.md) — the full Chinese README
- [`DESIGN.md`](DESIGN.md) — scope model, crawl boundaries, three measured appendices
- [`docs/permissions.md`](docs/permissions.md) — permission audit
- [`docs/ui.md`](docs/ui.md) — interface design, and how progress is reported honestly

## License

[Apache-2.0](LICENSE).

Doubak is an independent, third-party open-source tool. It is not affiliated with,
authorised by, or endorsed by Douban or its operators.
