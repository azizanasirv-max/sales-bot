import test from 'node:test';
import assert from 'node:assert/strict';
import { PreReadyAudioBuffer, DEFAULT_PRE_READY_AUDIO_LIMITS } from '../../src/lib/audioIngest';

test('audio buffer: preserves capture (FIFO) order and drains once', () => {
  const buffer = new PreReadyAudioBuffer();
  const payload = 'A'.repeat(64);
  for (let i = 0; i < 5; i += 1) {
    buffer.push({ seq: i + 1, audio: payload }, 1000 + i * 32);
  }
  assert.equal(buffer.size, 5);

  const drained = buffer.drain(1200);
  assert.deepEqual(
    drained.map((chunk) => chunk.seq),
    [1, 2, 3, 4, 5]
  );
  assert.equal(drained[0].bufferedAtMono, 1000);
  assert.equal(buffer.size, 0);
  assert.equal(buffer.byteLength, 0);
  // A second drain yields nothing: audio is never replayed twice.
  assert.deepEqual(buffer.drain(1300), []);
});

test('audio buffer: bounds the retained chunk count, dropping the oldest', () => {
  const buffer = new PreReadyAudioBuffer({ maxChunks: 3 });
  for (let i = 0; i < 6; i += 1) {
    buffer.push({ seq: i + 1, audio: 'x'.repeat(8) }, i * 32);
  }
  const stats = buffer.stats();
  assert.equal(stats.bufferedChunks, 3);
  assert.equal(stats.droppedOnOverflow, 3);
  assert.deepEqual(
    buffer.drain(200).map((chunk) => chunk.seq),
    [4, 5, 6]
  );
});

test('audio buffer: bounds total payload bytes', () => {
  const buffer = new PreReadyAudioBuffer({ maxChunks: 100, maxBytes: 100 });
  buffer.push({ audio: 'a'.repeat(60) }, 0);
  buffer.push({ audio: 'b'.repeat(60) }, 10);
  // 120 > 100 bytes, so the oldest chunk is evicted to make room.
  assert.equal(buffer.size, 1);
  assert.equal(buffer.byteLength, 60);
  assert.equal(buffer.stats().droppedOnOverflow, 1);
  assert.deepEqual(
    buffer.drain(20).map((chunk) => chunk.audio[0]),
    ['b']
  );

  // A single chunk larger than the whole budget is rejected, not buffered.
  const tiny = new PreReadyAudioBuffer({ maxBytes: 10 });
  const rejected = tiny.push({ audio: 'x'.repeat(11) }, 0);
  assert.equal(rejected.buffered, false);
  assert.equal(rejected.reason, 'overflow');
  assert.equal(tiny.size, 0);
});

test('audio buffer: expires stale speech instead of replaying it', () => {
  const buffer = new PreReadyAudioBuffer({ maxAgeMs: 1000 });
  buffer.push({ seq: 1, audio: 'old' }, 0);
  buffer.push({ seq: 2, audio: 'new' }, 900);
  assert.equal(buffer.size, 2);

  const drained = buffer.drain(1500);
  assert.deepEqual(drained.map((chunk) => chunk.seq), [2]);
  assert.equal(buffer.stats().droppedOnExpiry, 1);
});

test('audio buffer: empty payloads are ignored and clear() drops retained audio', () => {
  const buffer = new PreReadyAudioBuffer();
  assert.equal(buffer.push({ audio: '' }, 0).buffered, false);
  assert.equal(buffer.push({ audio: 'x' }, 1).buffered, true);
  assert.equal(buffer.push({ audio: 'y' }, 2).buffered, true);

  buffer.clear();
  assert.equal(buffer.size, 0);
  const stats = buffer.stats();
  assert.equal(stats.discardedOnClear, 2);
  // Cleared audio can never leak into a subsequent session/context.
  assert.deepEqual(buffer.drain(3), []);
});

test('audio buffer: reports a bounded span and defaults are documented', () => {
  assert.equal(DEFAULT_PRE_READY_AUDIO_LIMITS.maxChunks > 0, true);
  assert.equal(DEFAULT_PRE_READY_AUDIO_LIMITS.maxBytes > 0, true);
  const buffer = new PreReadyAudioBuffer();
  buffer.push({ audio: 'a' }, 1000);
  buffer.push({ audio: 'b' }, 1250);
  assert.equal(buffer.spanMs(), 250);
  assert.equal(buffer.stats().spanMs, 250);
});
