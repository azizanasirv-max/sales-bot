/**
 * Microphone ingestion primitives for the bridge.
 *
 * RECONSTRUCTED (Stage 5): the original Stage 3 `audioIngest.ts` could not be
 * recovered from any Git reference, Cline artifact or filesystem location. This
 * module re-implements the one piece of Stage 1/3 behaviour that was demonstrably
 * missing from the surviving bridge: microphone chunks captured before the Live
 * session reports `setupComplete` were dropped instead of being buffered, so the
 * first syllable of a short opening utterance could be lost.
 *
 * Design constraints:
 *  - FIFO order is preserved exactly (the Live API requires ordered audio).
 *  - The buffer is strictly bounded by chunk count, payload bytes and age, so a
 *    stalled session cannot grow memory without limit.
 *  - Buffering applies only to the very first `setupComplete` of a session. Audio
 *    captured while a ready session is reconnecting is still dropped (feeding it
 *    into the resumed VAD context would replay speech from before the gap).
 *  - Every instance belongs to exactly one bridge session, so buffered audio can
 *    never leak across sessions; `clear()` is called on teardown/replacement.
 */

export interface BufferedAudioChunk {
  /** Monotonic client sequence number, when supplied. */
  seq?: number;
  /** Base64-encoded 16 kHz mono signed-16-bit little-endian PCM. */
  audio: string;
  clientCaptureMono?: number;
  clientSentMono?: number;
  /** Bridge clock at which the chunk was buffered. */
  bufferedAtMono: number;
}

export interface PreReadyAudioLimits {
  /** Maximum number of chunks retained. */
  maxChunks: number;
  /** Maximum total base64 payload size retained (bytes of the encoded string). */
  maxBytes: number;
  /** Maximum age of a retained chunk before it is considered stale. */
  maxAgeMs: number;
}

export const DEFAULT_PRE_READY_AUDIO_LIMITS: PreReadyAudioLimits = {
  // ~8 s of 512-sample (≈32 ms) chunks. The first `setupComplete` normally
  // arrives in well under a second.
  maxChunks: 250,
  maxBytes: 512 * 1024,
  maxAgeMs: 15_000,
};

export interface PreReadyAudioStats {
  bufferedChunks: number;
  bufferedBytes: number;
  droppedOnOverflow: number;
  droppedOnExpiry: number;
  discardedOnClear: number;
  spanMs: number;
}

export interface PreReadyAudioPushResult {
  buffered: boolean;
  reason?: 'empty' | 'overflow' | 'disabled';
}

/**
 * Bounded FIFO buffer for audio captured before the session is ready.
 */
export class PreReadyAudioBuffer {
  private chunks: BufferedAudioChunk[] = [];
  private bytes = 0;
  private droppedOnOverflow = 0;
  private droppedOnExpiry = 0;
  private discardedOnClear = 0;
  private readonly limits: PreReadyAudioLimits;

  constructor(limits: Partial<PreReadyAudioLimits> = {}) {
    this.limits = { ...DEFAULT_PRE_READY_AUDIO_LIMITS, ...limits };
  }

  get size(): number {
    return this.chunks.length;
  }

  get byteLength(): number {
    return this.bytes;
  }

  /**
   * Appends one chunk, evicting the oldest data when a bound is exceeded.
   * Returns `buffered: false` only when the chunk cannot be retained at all.
   */
  push(
    chunk: Omit<BufferedAudioChunk, 'bufferedAtMono'>,
    nowMono: number
  ): PreReadyAudioPushResult {
    this.expire(nowMono);

    if (!chunk.audio) return { buffered: false, reason: 'empty' };
    if (this.limits.maxChunks <= 0 || this.limits.maxBytes <= 0) {
      this.droppedOnOverflow += 1;
      return { buffered: false, reason: 'disabled' };
    }

    const chunkBytes = chunk.audio.length;
    if (chunkBytes > this.limits.maxBytes) {
      // A single oversized chunk can never fit; drop it rather than flushing
      // the whole buffer for it.
      this.droppedOnOverflow += 1;
      return { buffered: false, reason: 'overflow' };
    }

    while (
      this.chunks.length > 0 &&
      (this.chunks.length >= this.limits.maxChunks ||
        this.bytes + chunkBytes > this.limits.maxBytes)
    ) {
      this.shiftOldest();
    }

    this.chunks.push({ ...chunk, bufferedAtMono: nowMono });
    this.bytes += chunkBytes;
    return { buffered: true };
  }

  /**
   * Removes and returns every retained chunk in capture order.
   */
  drain(nowMono: number = Number.POSITIVE_INFINITY): BufferedAudioChunk[] {
    this.expire(nowMono);
    const drained = this.chunks;
    this.chunks = [];
    this.bytes = 0;
    return drained;
  }

  /** Drops all retained audio (teardown / session replacement / start). */
  clear(): void {
    this.discardedOnClear += this.chunks.length;
    this.chunks = [];
    this.bytes = 0;
  }

  stats(): PreReadyAudioStats {
    return {
      bufferedChunks: this.chunks.length,
      bufferedBytes: this.bytes,
      droppedOnOverflow: this.droppedOnOverflow,
      droppedOnExpiry: this.droppedOnExpiry,
      discardedOnClear: this.discardedOnClear,
      spanMs: this.spanMs(),
    };
  }

  /** Milliseconds between the oldest and newest retained chunk. */
  spanMs(): number {
    if (this.chunks.length < 2) return 0;
    return Math.max(
      0,
      this.chunks[this.chunks.length - 1].bufferedAtMono - this.chunks[0].bufferedAtMono
    );
  }

  private expire(nowMono: number): void {
    if (!Number.isFinite(nowMono)) return;
    while (this.chunks.length > 0 && nowMono - this.chunks[0].bufferedAtMono > this.limits.maxAgeMs) {
      this.shiftOldest(true);
    }
  }

  private shiftOldest(expired = false): void {
    const removed = this.chunks.shift();
    if (!removed) return;
    this.bytes -= removed.audio.length;
    if (this.bytes < 0) this.bytes = 0;
    if (expired) this.droppedOnExpiry += 1;
    else this.droppedOnOverflow += 1;
  }
}
