# manga-app

A self-hosted manga / manhwa library and reader powered by the
[MangaDex](https://mangadex.org) public API, with **page translation** built in:
OCR the speech bubbles, machine-translate the text, and redraw it into the page
image — per page or for an entire chapter at once.

## Features

- **Discover & browse** — most-followed titles from MangaDex, plus full title
  detail (alt titles, tags, languages).
- **Import & download** — save titles to a local library and download whole
  chapters (original or data-saver quality, rate-limited to be polite to MDex).
- **Reader** — chapter browser with per-chapter downloads.
- **Translation** — Japanese-oriented OCR tuned for manga:
  - `manga-ocr` recognition model (trained on Japanese manga) with
    [RapidOCR](https://github.com/RapidAI/RapidOCR) box detection, via a Python
    sidecar;
  - `tesseract.js` fallback for non-Japanese pages or when the Python env is
    unavailable;
  - [DeepL](https://deepL.com) if a key is set, otherwise the free Google
    Translate endpoint;
  - translated text is **drawn back onto the page** and cached, so re-loading a
    translated page is instant and re-translating skips already-done pages.
- **Whole-chapter translation** — one click on the title page queues every page
  of a chapter; progress is reported live (the job tolerates server restarts
  because finished pages are cached on disk and skipped on re-run).

## How translation works

```
page → OCR (boxes) ──┐
                     ├─→ translate lines (DeepL | Google) → redraw text on image
```

1. **Detect + recognize** text boxes on the page.
   - `ja` pages use the sidecar: RapidOCR finds text regions, `manga-ocr`
     recognizes each crop (it is recognition-only and needs tight boxes).
   - Everything else (or a broken Python env) falls back to `tesseract.js`.
2. **Translate** the recognized lines as one batched request.
3. **Redraw**: measure the translated text, fit the speech-bubble area, and paint
   it over the original image with a matching bubble fill.

Results are cached under the chapter folder (`.ocr/` for OCR JSON, `.trl/` for
the rendered PNGs), so nothing is re-translated unless you clear the cache.

## Requirements

- Node.js ≥ 20 (npm workspaces; `better-sqlite3` needs a working toolchain)
- Python ≥ 3.10 — only for the optional manga-OCR sidecar

## Setup

```bash
npm install
```

### Optional: manga-OCR Python sidecar

If you want the good Japanese OCR instead of tesseract:

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
| `DEEPL_API_KEY`         | –            | `…:fx` free key → `api-free.deepl.com`, otherwise pro API      |
| `DEEPL_API_URL`         | –            | Override the DeepL base URL                                    |
| `TRANSLATE_SRC`         | `jpn`        | Source language assumed for page OCR                           |
| `MANGA_OCR`             | `1`          | `0` disables the manga-OCR sidecar (tesseract fallback)        |
| `MANGA_OCR_PYTHON`      | –            | Absolute path to the Python interpreter for the sidecar        |

## Layout (gitignored)

```
data/          SQLite DB (titles, chapters, download state)
library/       covers/            downloaded title covers
               data/<title>/<chapter>/  page images + .ocr/ + .trl/ caches
```

The repository itself contains only source; `node_modules/`, `data/`,
`library/`, `web/dist/`, `server/.venv-mangaocr/` and logs are excluded.

## Credits

- [MangaDex](https://mangadex.org) API and [Jikan](https://jikan.moe) (MAL)
- [manga-ocr](https://github.com/kha-white/manga-ocr) by kha-white (ONNX build
  by [mayocream](https://huggingface.co/mayocream/manga-ocr-onnx))
- [RapidOCR](https://github.com/RapidAI/RapidOCR)
- [tesseract.js](https://tesseract.projectnaptha.com)
- [DeepL](https://www.deepl.com) / [Google Translate](https://translate.google.com)