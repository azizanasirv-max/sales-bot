/**
 * Language-preference persistence.
 *
 * Kept separate from React so the policy (valid values only, storage failures
 * tolerated) can be unit-tested without a browser. The preference must survive
 * reconnects and page reloads, but a stale/invalid value must never be sent to
 * the bridge.
 */

export const LANGUAGE_STORAGE_KEY = 'GEMINI_LIVE_LANGUAGE';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem' | 'removeItem'>;

export function loadStoredLanguage(
  storage: ReadableStorage | null | undefined,
  validCodes: readonly string[]
): string {
  if (!storage) return '';
  try {
    const stored = storage.getItem(LANGUAGE_STORAGE_KEY) || '';
    return validCodes.includes(stored) ? stored : '';
  } catch {
    // Safari private mode / disabled storage can throw on access.
    return '';
  }
}

export function storeLanguage(
  storage: WritableStorage | null | undefined,
  value: string
): void {
  if (!storage) return;
  try {
    if (value) storage.setItem(LANGUAGE_STORAGE_KEY, value);
    else storage.removeItem(LANGUAGE_STORAGE_KEY);
  } catch {
    /* storage unavailable: the in-memory preference still applies */
  }
}
