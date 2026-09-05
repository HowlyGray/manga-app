import type {
  ChapterDetailResponse,
  DiscoverResponse,
  DownloadStatus,
  LibraryTitle,
  Progress,
  TitleDetailResponse,
} from './types';
import type {
  ChapterTranslateState,
  HomeResponse,
  PageOverlay,
  SearchSort,
  SourceInfo,
  Tag,
  TranslateLanguages,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      /* keep default message */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  sources() {
    return request<{ sources: SourceInfo[] }>('/api/sources');
  },

  tags(source?: string) {
    const s = new URLSearchParams();
    if (source) s.set('source', source);
    return request<{ source: string; tags: Tag[] }>(`/api/tags?${s.toString()}`);
  },

  home(source?: string) {
    const s = new URLSearchParams();
    if (source) s.set('source', source);
    return request<HomeResponse>(`/api/home?${s.toString()}`);
  },

  discover(
    params: {
      q?: string;
      lang?: string;
      source?: string;
      tags?: string[];
      sort?: SearchSort;
      createdSince?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const s = new URLSearchParams();
    if (params.q) s.set('q', params.q);
    if (params.lang) s.set('lang', params.lang);
    if (params.source) s.set('source', params.source);
    if (params.tags?.length) s.set('tags', params.tags.join(','));
    if (params.sort) s.set('sort', params.sort);
    if (params.createdSince) s.set('createdSince', params.createdSince);
    s.set('page', String(params.page ?? 1));
    s.set('limit', String(params.limit ?? 24));
    return request<DiscoverResponse>(`/api/discover?${s.toString()}`);
  },

  library() {
    return request<LibraryTitle[]>('/api/library');
  },

  title(id: string) {
    return request<TitleDetailResponse>(`/api/library/${id}`);
  },

  importTitle(id: string) {
    return request<{ id: string; source: string; title: string; chaptersImported: number; score: number | null }>(
      '/api/library/import',
      { method: 'POST', body: JSON.stringify({ id }) },
    );
  },

  downloadStatus(id: string) {
    return request<DownloadStatus>(`/api/library/${id}/download`);
  },

  startDownload(id: string) {
    return request<{ started: boolean; message?: string }>(`/api/library/${id}/download`, {
      method: 'POST',
    });
  },

  chapter(id: string, chapterId: string) {
    return request<ChapterDetailResponse>(`/api/library/${id}/chapters/${chapterId}`);
  },

  /** Reads a chapter straight from its source, without saving it. */
  previewChapter(id: string, chapterId: string) {
    return request<ChapterDetailResponse>(
      `/api/preview/${encodeURIComponent(id)}/${encodeURIComponent(chapterId)}`,
    );
  },

  downloadChapter(id: string, chapterId: string) {
    return request<{ started: boolean; message?: string }>(
      `/api/library/${id}/chapters/${chapterId}/download`,
      { method: 'POST' },
    );
  },

  progress(titleId: string) {
    return request<Progress>(`/api/progress/${titleId}`);
  },

  setProgress(titleId: string, chapterId: string, page: number, mode: string) {
    return request<{ ok: boolean }>('/api/progress', {
      method: 'POST',
      body: JSON.stringify({ titleId, chapterId, page, mode }),
    });
  },

  startChapterTranslate(titleId: string, chapterId: string, target: string) {
    const t = target.toUpperCase();
    return request<ChapterTranslateState>(`/api/translate/${titleId}/${chapterId}?target=${t}`, {
      method: 'POST',
    });
  },

  translateLanguages() {
    return request<TranslateLanguages>('/api/translate/languages');
  },

  pageOverlay(titleId: string, chapterId: string, page: number, target: string, refresh = false) {
    const t = target.toUpperCase();
    const bust = refresh ? '&refresh=1' : '';
    return request<PageOverlay>(
      `/api/translate/${titleId}/${chapterId}/${page}/overlay?target=${t}${bust}`,
    );
  },

  /** Teaches the app a reading, reused on every later page in that language. */
  saveCorrection(sourceLang: string, source: string, corrected: string) {
    return request<{ ok: boolean; removed?: boolean }>('/api/corrections', {
      method: 'POST',
      body: JSON.stringify({ sourceLang, source, corrected }),
    });
  },

  chapterTranslateStatus(titleId: string, chapterId: string, target: string) {
    const t = target.toUpperCase();
    return request<ChapterTranslateState>(`/api/translate/${titleId}/${chapterId}/status?target=${t}`);
  },
};