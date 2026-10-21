import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGE_STORAGE_KEY,
  loadStoredLanguage,
  storeLanguage,
} from '../../src/lib/languagePreference';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

const CODES = ['', 'en-US', 'ar-SA'];

test('language preference: persists a locked language across sessions', () => {
  const storage = memoryStorage();
  storeLanguage(storage, 'ar-SA');
  assert.equal(storage.getItem(LANGUAGE_STORAGE_KEY), 'ar-SA');
  assert.equal(loadStoredLanguage(storage, CODES), 'ar-SA');

  // A later session reads the same value (reconnect / page reload).
  assert.equal(loadStoredLanguage(storage, CODES), 'ar-SA');

  // Switching back to auto removes the key rather than storing "".
  storeLanguage(storage, '');
  assert.equal(storage.getItem(LANGUAGE_STORAGE_KEY), null);
  assert.equal(loadStoredLanguage(storage, CODES), '');
});

test('language preference: stale or unknown values are discarded, not forwarded', () => {
  const storage = memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'klingon' });
  assert.equal(loadStoredLanguage(storage, CODES), '');
});

test('language preference: unavailable storage never throws', () => {
  const throwing = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('SecurityError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
  };
  assert.equal(loadStoredLanguage(throwing, CODES), '');
  assert.doesNotThrow(() => storeLanguage(throwing, 'en-US'));
  assert.equal(loadStoredLanguage(null, CODES), '');
  assert.doesNotThrow(() => storeLanguage(undefined, 'en-US'));
});
