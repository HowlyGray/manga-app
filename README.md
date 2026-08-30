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
  or a flattened PNG you can export. Both come from the same layout, so they
  always agree.
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
                          clean PNG + HTML text layer          flattened PNG
```

1. **Pick the source language.** It comes from the *chapter*, not the title: a
   title whose `original_lang` is `ja` is routinely read through a Georgian or
   English scanlation, and OCR has to follow what is actually printed.
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
   use the surrounding bubbles as context.
7. **Erase and lay out.** A bubble is found by flood-filling the uniform region
   around the text and closing its interior holes, so only the balloon is
   repainted and the artwork survives; text sitting over artwork is never erased
   and gets a translucent plate instead. The translation is then fitted to the
   largest box that stays inside the balloon.

Results are cached under the chapter folder (`.ocr/` for OCR JSON, `.trl/` for
the layout JSON and rendered PNGs), so nothing is re-translated unless you clear
the cache. Cache names carry a pipeline version; after an upgrade the old files
are simply ignored, and `.trl/` can be deleted at any time.

## Requirements

- Node.js ≥ 20 (npm workspaces; `better-sqlite3` needs a working toolchain)
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
| `DATA_DIR`              | `./data`     | SQLite database location (`library.db`)                        |
| `LIBRARY_DIR`           | `./library`  | Downloaded pages and covers                                    |
| `MDX_API_MS`            | `260`        | MangaDex API request interval (ms)                             |
| `MDX_IMAGE_MS`          | `120`        | MangaDex image download interval (ms)                          |
| `MDX_IMAGE_CONCURRENCY` | `3`          | Parallel image downloads                                       |
| `MDX_QUALITY`           | `original`   | `original` or `data-saver`                                      |
| `JIKAN_API_MS`          | `380`        | Jikan (MyAnimeList) request interval (ms)                      |
| `ANTHROPIC_API_KEY`     | –            | Enables whole-page, context-aware translation with Claude      |
| `TRANSLATE_LLM`         | `1`          | `0` disables the Claude provider even when a key is set        |
| `TRANSLATE_LLM_MODEL`   | `claude-opus-5` | Model used for translation                                  |
| `TRANSLATE_LLM_EFFORT`  | `low`        | `low` / `medium` / `high` — bubble translation is a short task |
| `DEEPL_API_KEY`         | –            | `…:fx` free key → `api-free.deepl.com`, otherwise pro API      |
| `DEEPL_API_URL`         | –            | Override the DeepL base URL                                    |
| `TRANSLATE_SRC`         | `ja`         | Source language **only** for chapters with no language set     |
| `TRANSLATE_MIN_CONF`    | `55`         | Drop OCR lines below this confidence (0-100)                   |
| `TRANSLATE_REFINE`      | `1`          | `0` disables the whole-balloon re-read pass                     |
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
               data/<title>/<chapter>/  page images
                                        .ocr/  recognized text, per page
                                        .trl/  layout JSON + rendered pages
```

The repository itself contains only source; `node_modules/`, `data/`,
`library/`, `web/dist/`, `server/.venv-mangaocr/` and logs are excluded.

## Credits

- [MangaDex](https://mangadex.org) API and [Jikan](https://jikan.moe) (MAL)
- [manga-ocr](https://github.com/kha-white/manga-ocr) by kha-white (ONNX build
  by [mayocream](https://huggingface.co/mayocream/manga-ocr-onnx))
- [RapidOCR](https://github.com/RapidAI/RapidOCR)
- [tesseract.js](https://tesseract.projectnaptha.com)
- [Claude](https://www.anthropic.com) / [DeepL](https://www.deepl.com) /
  [Google Translate](https://translate.google.com)