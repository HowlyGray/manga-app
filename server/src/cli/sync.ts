import { searchManga } from '../api/mangadex';
import { getDb } from '../db';
import * as lib from '../services/library';
import { downloadTitle, importTitle, mainTitle } from '../services/ingest';

function parseArgs(argv: string[]): { flags: Record<string, string | boolean>; positionals: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

async function cmdDiscover(flags: Record<string, string | boolean>) {
  const lang = typeof flags.lang === 'string' ? flags.lang : undefined;
  const limit = typeof flags.limit === 'string' ? Number(flags.limit) : 24;
  const page = 1;
  console.log(`Discovering top manga${lang ? ` (lang=${lang})` : ''}...`);
  const { titles, total } = await searchManga({ lang, limit, offset: (page - 1) * limit });
  console.log(`  total matching: ${total}`);
  for (const t of titles) {
    const saved = lib.getTitle(t.id) ? ' [SAVED]' : '';
    console.log(`  ${t.id.padEnd(9)} ${t.originalLanguage ?? '??'}  ${mainTitle(t)}${saved}`);
  }
}

async function cmdImport(flags: Record<string, string | boolean>, name: string) {
  console.log(`Searching MangaDex for "${name}"...`);
  const { titles } = await searchManga({
    q: name,
    lang: typeof flags.lang === 'string' ? flags.lang : undefined,
    limit: 8,
  });
  if (titles.length === 0) {
    console.error('No results found.');
    return;
  }
  const pick = titles[0];
  console.log(`  matched: ${mainTitle(pick)} (${pick.id}) lang=${pick.originalLanguage ?? '??'}`);
  const result = await importTitle(pick.id);
  console.log(`Imported "${result.title}" — ${result.chaptersImported} chapters indexed (score=${result.score ?? 'n/a'})`);

  if (flags.download) {
    const status = await downloadTitle(pick.id);
    console.log(
      `Download complete: attempted=${status.attempted} downloaded=${status.downloaded} failed=${status.failed} skipped=${status.skipped}`,
    );
  }
}

async function cmdDownload(titleId: string) {
  const t = lib.getTitle(titleId);
  if (!t) {
    console.error(`Title ${titleId} is not in the library. Run "import" first.`);
    return;
  }
  console.log(`Downloading all chapters of "${t.title}"...`);
  const status = await downloadTitle(titleId);
  console.log(
    `Done: attempted=${status.attempted} downloaded=${status.downloaded} failed=${status.failed} skipped=${status.skipped}`,
  );
}

async function cmdList() {
  const titles = lib.listLibrary();
  if (titles.length === 0) {
    console.log('Library is empty. Use "import" or the web app.');
    return;
  }
  console.log(`${titles.length} title(s) in library:`);
  for (const t of titles) {
    console.log(
      `  ${t.id.padEnd(10)} ${t.title.padEnd(40)} ${t.downloaded_chapters}/${t.total_chapters} chapters  ${t.original_lang ?? '??'}`,
    );
  }
}

async function cmdStatus(titleId: string) {
  const t = lib.getTitle(titleId);
  if (!t) {
    console.error(`Title ${titleId} is not in the library.`);
    return;
  }
  const chapters = lib.listChapters(titleId);
  const summary = {
    downloaded: chapters.filter((c) => c.downloaded === 1).length,
    pending: chapters.filter((c) => c.downloaded === 0).length,
    failed: chapters.filter((c) => c.downloaded === -1).length,
  };
  console.log(`${t.title}: ${JSON.stringify(summary)}`);
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);

  switch (cmd) {
    case 'discover':
      await cmdDiscover(flags);
      break;
    case 'import':
      if (positionals.length === 0) {
        console.error('Usage: import "title" [--download] [--lang ko]');
        process.exit(1);
      }
      await cmdImport(flags, positionals.join(' '));
      break;
    case 'download':
      if (positionals.length === 0) {
        console.error('Usage: download <titleId>');
        process.exit(1);
      }
      await cmdDownload(positionals[0]);
      break;
    case 'list':
      await cmdList();
      break;
    case 'status':
      if (positionals.length === 0) {
        console.error('Usage: status <titleId>');
        process.exit(1);
      }
      await cmdStatus(positionals[0]);
      break;
    default:
      console.log(`
Manga app sync tool

Usage:
  npm run sync -w server -- <command> [options]

Commands:
  discover [--lang ko] [--limit 20]     List most-followed titles from MangaDex
  import "title" [--download]            Search + add to local library (optionally download all)
  download <titleId>                     Download all chapters of a saved title
  list                                   List saved titles + download status
  status <titleId>                       Show chapter download summary
`);
  }
}

getDb();
await main(process.argv.slice(2));