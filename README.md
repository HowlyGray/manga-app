# manga-app

A self-hosted manga / manhwa library and reader powered by the
[MangaDex](https://mangadex.org) public API, with **page translation** built in:
read the speech bubbles, machine-translate them, and put the text back on the
page — either as a live text layer over the cleaned scan or as a flattened
image, per page or for an entire chapter at once.

## Features

- **Discover & browse** — most-followed titles from MangaDex, plus full title
  detail (alt titles, tags, languages).
- **Import & download** — save titles to a local library and download whole
  chapters (original or data-saver quality, rate-limited to be polite to MDex).
- **Reader** — chapter browser with per-chapter downloads.
- **Reading progress** — every chapter remembers how far you got, reaching its
  last page marks it read, and a title's page says where to pick up.
- **New chapters** — one click checks every saved series again and flags what
  arrived since you last looked.
- **Disk space** — see what each title takes, and get space back by clearing
  translations, deleting a chapter's pages, or removing a title.
- **Translation** — OCR and machine translation tuned for comics:
  - text regions are found by [RapidOCR](https://github.com/RapidAI/RapidOCR)'s
    script-agnostic detector, then recognized per region by `manga-ocr` for
    Japanese or `tesseract.js` with the chapter's own traineddata otherwise;
  - lines are grouped into speech bubbles before translation, so a bubble is
    translated as one sentence instead of as disconnected fragments;
  - [Claude](https://www.anthropic.com) translates a whole page in one call when
    `ANTHROPIC_API_KEY` is set (keeps pronouns and register consistent),
    otherwise [DeepL](https://deepL.com) if a key is set, otherwise the free
    Google Translate endpoint;
  - the original lettering is erased inside its bubble — not under a rectangle —
    and text drawn over artwork is left alone.
- **Two ways to read a translated page** — a live HTML text layer over the
  cleaned scan (selectable, sharp at any zoom, one click to see the original),
  or a flattened image you can export. Both come from the same layout, so they
  agree — including after a correction, which redraws the flattened page.
- **Whole-chapter translation** — one click on the title page queues every page
  of a chapter; progress is reported live (the job tolerates server restarts
  because finished pages are cached on disk and skipped on re-run).

## How translation works

```
page → detect regions → recognize → group into bubbles → translate page
                                                              │
                                    ┌─────────────────────────┴──────────┐
                              erase bubbles                        layout text
                                    │                                    │
                         clean WebP + HTML text layer         flattened WebP
```

1. **Pick the source language.** It comes from the *chapter*, not the title: a
   title whose `original_lang` is `ja` is routinely read through a Georgian or
   English scanlation, and OCR has to follow what is actually printed. When a
   chapter exists in several languages, the one the chain reads best is chosen
   — see *Chapter language preference* below.
2. **Detect** text regions with RapidOCR. The detector is script-agnostic and
   returns tight per-line boxes; whole-page tesseract layout analysis is used
   only as a fallback, because on comics it merges text across panel borders.
3. **Recognize** each region — `manga-ocr` for Japanese, tesseract in
   single-line mode with the chapter's traineddata otherwise. Small crops are
   upscaled first, since tesseract needs roughly 30px of cap height.
4. **Group** the lines into bubbles: neighbouring boxes are clustered, ordered
   the way a reader would follow them (right-to-left columns for Japanese
   tategaki), and joined into one string. Translating line by line is what used
   to turn one sentence into six unrelated fragments.
5. **Re-read under-filled balloons** as a single block. The per-line pass drops
   short lines, which splits a bubble and loses words for good; once the balloon
   is known, handing the whole thing to tesseract recovers them. The re-read is
   only adopted when every word already recognized survives it and a genuinely
   new one appears, so a differently-garbled reading never replaces a good one.
   (Japanese pages skip this: `manga-ocr` is recognition-only.)
6. **Translate** every bubble of the page in a single request, so the engine can
   use the surrounding bubbles as context. When a page is re-run — after a
   correction, say — bubbles whose reading did not change keep the translation
   already paid for and are sent along as context only.
7. **Erase and lay out.** A bubble is found by flood-filling the uniform region
   around the text and closing its interior holes, so only the balloon is
   repainted and the artwork survives; text sitting over artwork is never erased
   and gets a translucent plate instead. The translation is then fitted to the
   largest box that stays inside the balloon.

Results are cached under the chapter folder (`.ocr/` for OCR JSON, `.trl/` for
the layout JSON and rendered WebP pages), so nothing is re-translated unless you
clear the cache. Cache names carry a pipeline version; files from any other
version are deleted when the server starts, and `.trl/` can be deleted at any
time.

The reader asks for a page's translation only once the page is within a screen
of the viewport, and stops asking when you leave the chapter, so opening a
chapter no longer translates all of it.

Two requests for the same page, such as the text layer and the flattened image,
or two open tabs, share one analysis rather than running OCR twice. Tesseract
stays loaded for five minutes after a page instead of starting again for every
one. Laying out a page pauses between balloons, so the reader's image requests
are not held up behind it. On a downloaded page, the longest the server went
without answering fell from about 350 ms to under 60 ms.

## Sources

MangaDex is one provider behind a common interface rather than the only way in.
A provider supplies search, title metadata, a chapter index, and the page images
of a chapter (`server/src/sources/types.ts`); everything else in the app works
in those terms and never learns where a page came from.

Library ids stay bare for MangaDex (`<uuid>`) and carry a `provider:` prefix for
everyone else (`comick:abc`), so ids are unique across providers with no
migration, and any row can be traced back to the source that produced it.
`GET /api/sources` lists what is registered; `GET /api/discover?source=<id>`
searches one of them.

Two are built in:

| Source | Notes |
| --- | --- |
| **MangaDex** | Public API, many languages. Lost 700+ series and over a quarter of its chapters to publisher DMCA notices in 2025, so a title can be listed with no readable chapters left. |
| **WeebCentral** | HTML, English only — which is also the language the OCR chain reads best. Useful precisely for the series MangaDex no longer carries. Set `WEEBCENTRAL=0` to disable. |

WeebCentral has no API, so its provider parses HTML. Every pattern is anchored
on a structural landmark rather than on styling, and a page that fails to parse
yields an empty result instead of throwing — but it is scraping, and scraping
breaks when a site is redesigned.

To add a source, implement `SourceProvider` under `server/src/sources/` and
register it in `server/src/sources/index.ts`.

## Browsing

The home page is a trends view rather than a search box: rows for what is most
followed, what updated most recently, what was added in the last 30 days ranked
by followers, and what is rated highest, plus one-click genre shortcuts. Rows
are built from four searches and cached for ten minutes — the point is what is
moving, not up-to-the-second accuracy.

`/browse` is the full catalogue: search, source, order, original language, and
a tag picker grouped into genre / theme / format (77 tags on MangaDex, and a
title must carry all the ones you pick). Every filter lives in the URL, so a
genre chip, a shelf's *See all*, and the browser's back button all work the way
you would expect, and a filtered view can be bookmarked.

Sources declare what they support: `GET /api/sources` reports `hasTags` and
`hasShelves`, and the UI hides genre browsing for a source that has no tag
vocabulary rather than showing an empty picker.

## When a reading is not trustworthy

OCR quality varies bubble to bubble, and a confident translation of something
the engine could not read is worse than a visible doubt. Two things address it.

A reading carrying a character that cannot belong to a word — `@`, `&`, `⁄`,
`^` — is **marked in the reader** with a dashed outline; hovering shows the raw
text and the confidence. This is a hard signal, unlike confidence itself:
measured over a Vietnamese chapter, tesseract scored 36% of lines below 40 even
where the reading was fine, so a confidence threshold alone would flag half the
book. `@` appeared 21 times in that chapter and was a misread `G` every time
("@IÚP" for "GIÚP").

**Corrections are remembered.** Click the pencil on any bubble, fix what was
read, and the correction is stored against that source language and applied to
every later page — the same lettering misreads the same way throughout a
series, so one fix keeps paying off. This is the only thing in the app that
learns, and what it learns is your judgement, not a model's guess.

A fix works at two levels. The whole bubble is remembered, so the same bubble
read the same way again gets the whole fix. And a word that can only be a
misread — it carries one of those impossible characters, or digits inside
letters like `0K` — is learned on its own, so fixing "LÄ @IÚP" once also fixes
`@IÚP` in every other bubble. Letters-only edits ("THEN" to "THEY") stay with
their bubble, since a real rewording applied everywhere would do damage.
Re-editing a bubble replaces what it taught; clearing the text removes both.

Constraining tesseract to the language's alphabet was tried and rejected. It
does remove the impossible characters, but by *deleting* them rather than
correcting them: "@IÚP" became "IÚP" and mean confidence fell from 64 to 58.
That trades text visibly broken — and therefore recoverable — for text that
looks clean and has lost a letter.

The largest remaining lever is the Claude provider, which is off unless
`ANTHROPIC_API_KEY` is set. It reads the whole page at once and knows the
language, so it repairs "LÄ @IÚP" to "LÀ GIÚP" on its own; DeepL and Google see
one bubble at a time and translate the damage literally.

## Preview before downloading

Opening a chapter no longer imports the title and downloads every page first.
Anything not already on disk is **streamed from its source**: the reader shows
the pages, and a banner offers to download the chapter when you decide to keep
it. Nothing is written until you do — no title row, no chapter row, no files.

That applies to any title, saved or not, so a series can be sampled straight
from a search result. Downloading afterwards imports the title and adds the
exact chapter you were reading, which matters because an import otherwise keeps
only one chapter per number, in the language the OCR chain reads best.

Translation is the one thing preview cannot do: the pipeline works on local
files, so the control stays disabled until the chapter is downloaded.

## Keeping up with a series

**Reading is remembered per chapter**, for any title, saved or only previewed.
Reaching a chapter's last page marks it read, and scrolling back up does not
undo that. A title's page shows where to pick up (*Continue: Ch. 12 · p. 8*
while a chapter is unfinished, *Next: Ch. 13* once it is done), how many
chapters are read, and a **Mark read** toggle on each row for chapters read
elsewhere. Opening a chapter goes back to the page you left, unless you
finished it.

**New chapters turn up by themselves.** The server looks for them shortly after
it starts, every 30 minutes while it runs, and whenever the web app is opened,
on whichever page it opens. A title is only looked at again once its last check
is three hours old, so opening the app five times in an hour costs one check.
The top bar says how far it is while it runs and how many chapters it found.
Nothing is downloaded. New chapter numbers are marked NEW on the title's page,
with a banner pointing at the first, and counted on its card until you open the
title. A chapter that only turned up in another language does not count, and
neither does one you already read in preview. A title's details (status,
synopsis, tags) are refreshed by the same check, so *ongoing* turns to
*completed* without anyone pressing anything.

The check is incremental. The first time a title is looked at, every chapter is
listed; after that only what was added or changed since the last check is asked
for, which turns a series of a thousand chapters in a dozen languages from
twenty requests into two or three. A source that cannot be read is reported and
never mistaken for "nothing new": the title stays due for the next try, and a
source that fails three titles in a row is left alone until the next check
rather than asked about every remaining title. Sources are checked side by
side, titles one at a time within each, at the source's rate limit.

Opening a title's page also asks its source about it, unless it was checked in
the last five minutes. **Refresh** on that page lists every chapter again, not
only what changed, and offers a translation that reads better than the copy
you hold for a chapter number; the page says how many it added, and the
language filters show them. **Check for new chapters**, on the Library page,
checks every title now instead of only the stale ones. `AUTO_UPDATE=0` turns
the automatic checks off and leaves the buttons.

Counts go by chapter number. The same number can be stored twice, for instance
when a better translation of a chapter arrives after the first was saved; that
is still one chapter to read, and *Next* skips to the next number.

## Cache

Anything a source tells the app is kept, so browsing the same page twice costs
the upstream service nothing.

- **Covers** land in `library/covers/cache/` the first time a tile is displayed
  and are never refetched — a cover for a given title does not change. Every
  card points at `/api/cover/<id>` rather than at the upstream CDN, so the
  server can serve the stored copy. Roughly 50 KB each; delete the folder at any
  time to reclaim the space.
- **Title metadata** (description, tags, author, status, cover URL) and
  **chapter indexes** are stored in the `source_cache` table. Metadata expires
  after a week and chapter indexes after an hour, because new chapters appear
  constantly and a synopsis does not. Both are configurable, and
  `GET /api/library/<id>?refresh=1` bypasses them for one read.

Measured on a title outside the library: metadata 0.94s cold against 0.20s
warm, a cover 1.02s against 0.21s.

## Disk space

The Library page shows how much is on disk, split into scanned pages and
translations, and each card shows its title's size. A title's page has three
ways to get space back:

- **Clear translations** deletes the rendered pages and layouts under `.trl/`.
  They are rebuilt the next time the title is read translated. OCR results are
  kept, so the rebuild skips recognition but does translate again, which costs
  API credit with Claude or DeepL.
- **🗑** on a downloaded chapter deletes its pages. The chapter stays in the
  list and can be downloaded again.
- **Remove from library** deletes the title's folder, its cover, and its
  reading history.

Each one asks first, and none runs while that title is downloading or being
translated.

## Chapter language preference

A series often exists in several fan translations, and which one you download
decides how good the machine translation can be: English and the major Latin
languages OCR cleanly and translate well, Japanese has a purpose-built
recognition model, while Georgian, Hebrew, Thai and Arabic have weak
traineddata and produce partial readings at best.

The app therefore keeps one chapter per chapter number, choosing the language
it reads best. The default order is English, then Latin languages DeepL
supports, then Japanese, then Latin languages it does not, then Cyrillic, then
Chinese and Korean, then everything else. Override it with `DOWNLOAD_LANGS`:

```bash
DOWNLOAD_LANGS=pt-br,es,en npm run dev
```

This only decides *which* translation gets downloaded; it is unrelated to the
target language you read in. Among translations that read equally well, the
language the library already holds for the title wins, then the one that
covers the most chapters, so a series does not change language from one chapter
to the next. Chapters already on disk are never re-downloaded because a better
language showed up. Checks for new chapters only add chapter numbers the
library lacks; to get a better translation of a chapter you already have, press
**Refresh** on the title's page and pick the language from the filters.

## Requirements

- Node.js 22.12 or newer; CI runs 24 (npm workspaces; `better-sqlite3` needs a
  working toolchain)
- Python ≥ 3.10 — for the OCR sidecar. It is optional, but without it text
  detection falls back to whole-page tesseract, which is markedly worse on
  comics; it is worth installing even if you never read Japanese.

## Setup

```bash
npm install
```

### Recommended: the OCR sidecar

RapidOCR (text detection, every language) plus manga-ocr (Japanese
recognition):

```bash
cd server
py -m venv .venv-mangaocr
.venv-mangaocr\Scripts\python -m pip install -U pip
.venv-mangaocr\Scripts\python -m pip install manga-ocr-torchless "transformers<5" sentencepiece rapidocr-onnxruntime
```

Notes:

- `transformers` must be pinned **below v5** — newer releases break the slow
  tokenizer that `manga-ocr`'s `BertJapaneseTokenizer` needs.
- The ONNX model (~400 MB, `mayocream/manga-ocr-onnx`) is downloaded from
  Hugging Face automatically on first use.
- On non-Windows the venv lives at `server/.venv-mangaocr/bin/`. Set
  `MANGA_OCR_PYTHON` to point elsewhere, or `MANGA_OCR=0` to disable the engine.
- The sidecar stays resident between pages (the recognition model takes ~18s to
  load) and shuts itself down after `MANGA_OCR_IDLE_MS` of inactivity.

### Optional: context-aware translation

Set `ANTHROPIC_API_KEY` and every bubble on a page is translated in one call
with the rest of the page as context, which is what keeps pronouns, honorifics
and tone consistent. Without it the app falls back to DeepL (if `DEEPL_API_KEY`
is set) and then to the free Google endpoint, which translate each bubble in
isolation. The reader says which engine produced what you are looking at.

## Running

Development (server + Vite with HMR):

```bash
npm run dev
```

Production-style (build the frontend once, serve it from Express):

```bash
npm run build        # builds web/dist
npm start -w server  # serves API + web/dist on PORT (default 5180)
```

Open http://localhost:5180.

## Tests

```bash
npm test
```

This runs the server suite and the web suite, both on Vitest. The server suite
covers the API routes, the translation pipeline on a generated page, OCR
caching, corrections, reading progress, new-chapter checks (what a refresh asks
a source for, what it keeps, and how a failing source is handled), MangaDex's
chapter listing and disk usage. The
web suite covers how the reader requests translated pages, how a title decides
where to continue, which chapters the reader moves between, and how the app
follows the check for new chapters. Nothing reaches the network: each test file gets its
own temporary library and database, sources are replaced by fakes, and any
other `fetch` is refused. GitHub Actions runs the typecheck, the tests and the
build on every push to `main` and on every pull request.

## Reading on your phone or tablet

By default the app only listens on this machine. Build once and serve
everything from the API port, opened to your network:

```bash
npm run serve:lan
```

The console prints the address to open on the other device:

```
Manga app server listening on http://localhost:5180
  on this network:  http://192.168.1.42:5180
```

`npm run dev:lan` does the same for the development setup, on port 5173. Setting
`HOST=0.0.0.0` has the same effect as the `:lan` scripts.

Requests are only accepted for hostnames that point at this machine (its name,
its addresses, `localhost`). If you reach it through some other name — a router
DNS entry, a tunnel — add that name to `ALLOWED_HOSTS`.

**On Windows the firewall blocks this until you allow the port.** Inbound
connections are denied by default and no rule exists for Node, so the phone will
simply time out. In an **Administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Manga app" -Direction Inbound -Protocol TCP -LocalPort 5180 -Action Allow -Profile Private
```

Add `-LocalPort 5180,5173` instead if you also want the dev server reachable.
Keep it to `-Profile Private`: on a public network that rule would expose the
app to strangers. To undo it later:

```powershell
Remove-NetFirewallRule -DisplayName "Manga app"
```

**The app has no authentication.** Once opened to the network, anyone on it who
opens the address gets full access, including downloading, and removing titles
and their files, through the API. That is fine for a home network and not
fine for a shared or public one. Other *websites* are kept out either way: the
API sends no CORS headers and refuses requests a browser marks as coming from
another site, so a page you visit cannot read your library or start
translations that spend your API credit.

## CLI sync tool

```bash
npm run sync -w server -- <command> [options]

  discover [--lang ko] [--limit 20]    List most-followed titles from MangaDex
  import "title" [--download]          Search + add to local library
  download <titleId>                   Download all chapters of a saved title
  list                                 List saved titles + download status
  status <titleId>                     Show chapter download summary
```

## Configuration (environment variables)

| Variable                | Default      | Description                                                    |
| ----------------------- | ------------ | -------------------------------------------------------------- |
| `PORT`                  | `5180`       | HTTP port for the server                                       |
| `HOST`                  | `127.0.0.1`  | Bind address; `0.0.0.0` (or the `:lan` scripts) opens it to the network |
| `ALLOWED_HOSTS`         | –            | Extra hostnames to accept, comma-separated (e.g. `mypc.lan`)   |
| `DATA_DIR`              | `./data`     | SQLite database location (`library.db`)                        |
| `LIBRARY_DIR`           | `./library`  | Downloaded pages and covers                                    |
| `MDX_API_MS`            | `260`        | MangaDex API request interval (ms)                             |
| `MDX_IMAGE_MS`          | `120`        | MangaDex image download interval (ms)                          |
| `MDX_IMAGE_CONCURRENCY` | `3`          | Parallel image downloads                                       |
| `MDX_QUALITY`           | `original`   | `original` or `data-saver`                                      |
| `JIKAN_API_MS`          | `380`        | Jikan (MyAnimeList) request interval (ms)                      |
| `WEEBCENTRAL`           | `1`          | `0` removes the WeebCentral source                             |
| `WEEBCENTRAL_MS`        | `700`        | WeebCentral request interval (ms)                              |
| `ANTHROPIC_API_KEY`     | –            | Enables whole-page, context-aware translation with Claude      |
| `TRANSLATE_LLM`         | `1`          | `0` disables the Claude provider even when a key is set        |
| `TRANSLATE_LLM_MODEL`   | `claude-opus-5` | Model used for translation                                  |
| `TRANSLATE_LLM_EFFORT`  | `low`        | `low` / `medium` / `high` — bubble translation is a short task |
| `DEEPL_API_KEY`         | –            | `…:fx` free key → `api-free.deepl.com`, otherwise pro API      |
| `DEEPL_API_URL`         | –            | Override the DeepL base URL                                    |
| `DOWNLOAD_LANGS`        | –            | Preferred chapter languages, best first (e.g. `pt-br,es,en`)   |
| `TRANSLATE_SRC`         | `ja`         | Source language **only** for chapters with no language set     |
| `AUTO_UPDATE`           | `1`          | `0` stops the automatic checks for new chapters                |
| `UPDATE_STALE_MS`       | `10800000`   | A title is checked again once its last check is this old (3 h) |
| `UPDATE_INTERVAL_MS`    | `1800000`    | How often the running server checks for stale titles (30 min)  |
| `UPDATE_START_MS`       | `5000`       | Delay before the first check after the server starts           |
| `UPDATE_TITLE_MS`       | `300000`     | Opening a title page skips its check if done this recently (5 min) |
| `CACHE_TITLE_MS`        | `604800000`  | How long cached title metadata stays fresh (7 days)            |
| `CACHE_CHAPTERS_MS`     | `3600000`    | How long a cached chapter index stays fresh (1 hour)           |
| `CACHE_COVER_CONCURRENCY` | `6`        | Parallel cover downloads when a grid first loads               |
| `CACHE_PAGES_MS`        | `600000`     | How long previewed page URLs stay usable (they expire upstream)|
| `TRANSLATE_MIN_CONF`    | `55`         | Drop OCR lines below this confidence (0-100)                   |
| `TRANSLATE_REFINE`      | `1`          | `0` disables the whole-balloon re-read pass                     |
| `TRANSLATE_UNCERTAIN_CONF` | `35`      | Below this confidence a reading is marked unreliable            |
| `TRANSLATE_FONT`        | –            | Path to the font used for baked pages (a bold comic face)      |
| `TRANSLATE_FONT_CJK`    | –            | Path to the font used when the target language is CJK          |
| `TRANSLATE_DET_THRESH`  | `0.15`       | Text-detection pixel threshold; lower finds fainter lettering  |
| `TRANSLATE_DET_BOX_THRESH` | `0.25`    | Text-detection box score threshold                             |
| `TRANSLATE_DET_UNCLIP`  | `1.8`        | How much detected boxes are grown around the glyphs            |
| `TRANSLATE_DET_SIDE`    | `1280`       | Detector input size (short side, px)                           |
| `MANGA_OCR`             | `1`          | `0` disables the Python sidecar (whole-page tesseract instead) |
| `MANGA_OCR_PYTHON`      | –            | Absolute path to the Python interpreter for the sidecar        |
| `MANGA_OCR_IDLE_MS`     | `300000`     | Idle time before the resident sidecar shuts down               |

## Layout (gitignored)

```
data/          SQLite DB (titles, chapters, download state)
library/       covers/            downloaded title covers
               covers/cache/      covers of titles only browsed
               data/<title>/<chapter>/  page images
                                        .ocr/  recognized text, per page
                                        .trl/  layout JSON + rendered pages
```

The repository itself contains only source; `node_modules/`, `data/`,
`library/`, `web/dist/`, `server/.venv-mangaocr/` and logs are excluded.

## Credits

- [MangaDex](https://mangadex.org) API, [WeebCentral](https://weebcentral.com)
  and [Jikan](https://jikan.moe) (MAL)
- [manga-ocr](https://github.com/kha-white/manga-ocr) by kha-white (ONNX build
  by [mayocream](https://huggingface.co/mayocream/manga-ocr-onnx))
- [RapidOCR](https://github.com/RapidAI/RapidOCR)
- [tesseract.js](https://tesseract.projectnaptha.com)
- [Claude](https://www.anthropic.com) / [DeepL](https://www.deepl.com) /
  [Google Translate](https://translate.google.com)