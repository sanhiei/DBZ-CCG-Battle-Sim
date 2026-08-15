/**
 * Slices individual card faces out of the TTS sprite-sheet atlases.
 *
 * Atlases are large (up to ~8300x7900, 140MB PNG), so each one is decoded
 * exactly once into a raw buffer and every card on it is cropped from that
 * buffer. Decoding per-card instead would re-decode the sheet ~70 times.
 */
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { TtsCard } from './types.js';

/** JPEG quality for sliced faces. High, because these feed OCR. */
export const SLICE_QUALITY = 92;

export interface SliceStats {
  written: number;
  skipped: number;
  failed: number;
}

/** Download an atlas we don't already have cached. */
export async function downloadAtlas(url: string, destDir: string, name: string): Promise<string> {
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, name);
  if (existsSync(dest)) return dest;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  // Write to a temp name first so an interrupted run never leaves a partial file
  // that a later run would treat as cached.
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
  await rename(tmp, dest);
  return dest;
}

/**
 * Crop every supplied card out of one atlas.
 *
 * Cell size is derived from the real image dimensions rather than assumed, since
 * the sheets are not all the same resolution.
 */
export async function sliceAtlas(
  atlasPath: string,
  cards: TtsCard[],
  outDir: string,
  onProgress?: (card: TtsCard, outPath: string) => void,
): Promise<SliceStats> {
  const stats: SliceStats = { written: 0, skipped: 0, failed: 0 };
  const pending = cards.filter((c) => !existsSync(join(outDir, `${c.id}.jpg`)));
  stats.skipped = cards.length - pending.length;
  if (pending.length === 0) return stats;

  mkdirSync(outDir, { recursive: true });

  // One decode for the whole sheet.
  const { data, info } = await sharp(atlasPath, { limitInputPixels: false })
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (const card of pending) {
    const cellW = Math.floor(info.width / card.atlas.numWidth);
    const cellH = Math.floor(info.height / card.atlas.numHeight);
    const left = card.atlas.col * cellW;
    const top = card.atlas.row * cellH;

    // Guard against a CardID that points outside its sheet.
    if (cellW <= 0 || cellH <= 0 || left + cellW > info.width || top + cellH > info.height) {
      stats.failed++;
      continue;
    }

    const outPath = join(outDir, `${card.id}.jpg`);
    const tmpPath = `${outPath}.part`;
    try {
      await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
        .extract({ left, top, width: cellW, height: cellH })
        .jpeg({ quality: SLICE_QUALITY })
        .toFile(tmpPath);
      await rename(tmpPath, outPath);
      stats.written++;
      onProgress?.(card, outPath);
    } catch {
      stats.failed++;
      await unlink(tmpPath).catch(() => {});
    }
  }

  return stats;
}
