import type {
  ChapterDetailResponse,
  DiscoverResponse,
  DownloadStatus,
  LibraryTitle,
  Progress,
  TitleDetailResponse,
} from './types';
import type { ChapterTranslateState } from './types';

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
  discover(params: { q?: string; lang?: string; page?: number; limit?: number } = {}) {
    const s = new URLSearchParams();
    if (params.q) s.set('q', params.q);
    if (params.lang) s.set('lang', params.lang);
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

  importTitle(mangadexId: string) {
    return request<{ id: string; title: string; chaptersImported: number; score: number | null }>(
      '/api/library/import',
      { method: 'POST', body: JSON.stringify({ mangadexId }) },
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

  chapterTranslateStatus(titleId: string, chapterId: string, target: string) {
    const t = target.toUpperCase();
    return request<ChapterTranslateState>(`/api/translate/${titleId}/${chapterId}/status?target=${t}`);
  },
};