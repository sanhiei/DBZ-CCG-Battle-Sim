/**
 * Maps atlas URLs to Tabletop Simulator's local image cache.
 *
 * TTS caches a downloaded image under a filename derived from its URL with every
 * non-alphanumeric character removed, plus the real extension. So
 *   http://u.cubeupload.com/Strinder/Pacsaiyan.jpg
 * is stored as
 *   httpucubeuploadcomStrinderPacsaiyanjpg.jpg
 * Using the cache avoids re-downloading gigabytes the user already has on disk.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_TTS_DIR = join(homedir(), 'Documents', 'My Games', 'Tabletop Simulator');

export function ttsImageCacheDir(ttsDir: string = DEFAULT_TTS_DIR): string {
  return join(ttsDir, 'Mods', 'Images');
}

export function workshopDir(ttsDir: string = DEFAULT_TTS_DIR): string {
  return join(ttsDir, 'Mods', 'Workshop');
}

/** TTS's cache-filename transform. */
export function cacheKey(url: string): string {
  return url.replace(/[^a-zA-Z0-9]/g, '');
}

export interface CacheIndex {
  dir: string;
  /** cacheKey -> absolute file path */
  byKey: Map<string, string>;
}

export function buildCacheIndex(dir: string = ttsImageCacheDir()): CacheIndex {
  const byKey = new Map<string, string>();
  if (!existsSync(dir)) return { dir, byKey };
  for (const file of readdirSync(dir)) {
    const withoutExt = file.replace(/\.(png|jpg|jpeg|webp)$/i, '');
    byKey.set(cacheKey(withoutExt), join(dir, file));
  }
  return { dir, byKey };
}

/** Local path for an atlas URL, or undefined if TTS has not cached it. */
export function findCached(url: string, index: CacheIndex): string | undefined {
  return index.byKey.get(cacheKey(url));
}
