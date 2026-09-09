/**
 * Custom playmat art.
 *
 * Each player picks their own and sees their own: the image is held as a data
 * URL in this browser's localStorage and never crosses the wire. That is a
 * deliberate limit rather than an oversight — a playmat is often a multi-megabyte
 * image, and pushing one through the game state would put it in every state
 * broadcast for the rest of the session. Your opponent sees the default mat on
 * your side, not yours.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const KEY = 'dbz.playmat';
/**
 * The table's shared mat, served by the host from data/playmats/. It is
 * franchise artwork and gitignored for the same reason the card faces are, so
 * a clone without it simply gets the plain surface instead.
 */
export const SHARED_MAT = '/playmat/default';
/** Data URLs are ~33% bigger than the file; localStorage caps out around 5MB. */
const MAX_BYTES = 3 * 1024 * 1024;

export function usePlaymat(): {
  mat: string | null;
  error: string | null;
  set(file: File): void;
  clear(): void;
} {
  const [mat, setMat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Storage can throw outright in a private window or with site data blocked,
    // so a missing playmat must never take the board down with it.
    try {
      setMat(localStorage.getItem(KEY));
    } catch {
      setMat(null);
    }
  }, []);

  const set = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('That is not an image.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`That image is ${(file.size / 1024 / 1024).toFixed(1)}MB — keep it under 3MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      setMat(url);
      setError(null);
      try {
        localStorage.setItem(KEY, url);
      } catch {
        // It still works for this session; it just will not be remembered.
        setError('Saved for now, but this browser would not store it for next time.');
      }
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsDataURL(file);
  }, []);

  const clear = useCallback(() => {
    setMat(null);
    setError(null);
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing to undo */
    }
  }, []);

  return { mat, error, set, clear };
}


/**
 * Whether the host actually has a shared mat. Asking first means a missing file
 * shows the plain table rather than a broken-image background.
 */
export function useSharedMat(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => alive && setUrl(SHARED_MAT);
    img.onerror = () => alive && setUrl(null);
    img.src = SHARED_MAT;
    return () => {
      alive = false;
    };
  }, []);
  return url;
}

export function PlaymatPicker({
  mat,
  error,
  onPick,
  onClear,
}: {
  mat: string | null;
  error: string | null;
  onPick(file: File): void;
  onClear(): void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <div className="matpick">
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          // Let the same file be chosen twice in a row.
          e.target.value = '';
        }}
      />
      <button className="ghost" onClick={() => input.current?.click()}>
        {mat ? 'Change playmat' : 'Playmat'}
      </button>
      {mat && (
        <button className="ghost" onClick={onClear}>
          Remove
        </button>
      )}
      {error && <span className="matpick__err">{error}</span>}
    </div>
  );
}
