/**
 * Source registry and library id encoding.
 *
 * Library ids stay provider-local for MangaDex (`<uuid>`) so rows written
 * before multiple sources existed keep working, and carry a `provider:` prefix
 * for everyone else. That keeps ids unique across providers without a
 * migration, and `decodeId` tells the ingest and download paths who to ask.
 */
import { config } from '../config';
import { mangadexProvider } from './mangadex';
import { weebcentralProvider } from './weebcentral';
import type { SourceProvider } from './types';

export * from './types';
export { mainTitle, synopsisEn } from './mangadex';

/** The provider used when a request does not name one. */
export const DEFAULT_SOURCE = 'mangadex';

const registry = new Map<string, SourceProvider>([[mangadexProvider.id, mangadexProvider]]);
if (config.weebcentral.enabled) registry.set(weebcentralProvider.id, weebcentralProvider);

/** Registers a provider. Call at startup, before any request is served. */
export function registerProvider(provider: SourceProvider): void {
  registry.set(provider.id, provider);
}

export function listProviders(): SourceProvider[] {
  return [...registry.values()];
}

export function hasProvider(id: string): boolean {
  return registry.has(id);
}

/** Throws when the id is unknown, so routes surface a clear 400. */
export function getProvider(id: string | null | undefined): SourceProvider {
  const key = (id ?? DEFAULT_SOURCE).trim().toLowerCase();
  const provider = registry.get(key);
  if (!provider) throw new Error(`unknown source: ${key}`);
  return provider;
}

export interface SourceRef {
  provider: string;
  /** Identifier as the provider knows it. */
  providerId: string;
}

/** Library id for a provider-local id. MangaDex ids are left bare. */
export function encodeId(provider: string, providerId: string): string {
  return provider === DEFAULT_SOURCE ? providerId : `${provider}:${providerId}`;
}

/** Splits a library id back into its provider and provider-local id. */
export function decodeId(id: string): SourceRef {
  const at = id.indexOf(':');
  if (at > 0) {
    const prefix = id.slice(0, at);
    if (registry.has(prefix)) return { provider: prefix, providerId: id.slice(at + 1) };
  }
  return { provider: DEFAULT_SOURCE, providerId: id };
}

/** A bare MangaDex UUID, or `provider:` followed by a provider-local id. */
const LIBRARY_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z][a-z0-9_-]*:[A-Za-z0-9][\w.-]*)$/i;

/**
 * Shape check for an id that arrives in a URL or request body. Ids end up as
 * directory names, so anything that could climb out of the library is refused
 * at the door instead of being left to later sanitizing.
 */
export function isLibraryId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 200 && LIBRARY_ID.test(id);
}
