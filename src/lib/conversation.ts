/**
 * Conversation, language-policy and turn lifecycle primitives.
 *
 * This module is intentionally free of DOM/Node APIs so it can be shared by
 * the browser client (src/App.tsx) and the server bridge (server.ts), and
 * unit-tested without a browser, audio hardware or live Gemini connection.
 *
 * Responsibilities:
 *  - Resolve/validate the session language preference and build the language
 *    policy that is sent to the model.
 *  - Track generation IDs so audio from an interrupted/superseded response can
 *    never be scheduled, while audio for the *next* response is never dropped.
 *  - Own the turn ledger so a late `turn_complete` can only close the turn it
 *    actually refers to.
 */

export const INITIAL_GENERATION_ID = 'gen_0';

export type TurnStatus = 'responding' | 'completed' | 'interrupted';

export interface LedgerTurn {
  id: string;
  generationId: string;
  turnNumber: number;
  startTimeUtc: string;
  firstAudioLatencyMs?: number;
  text: string;
  audioChunksCount: number;
  totalAudioDurationMs: number;
  status: TurnStatus;
}

export interface LanguagePreference {
  /** ISO 639-1 (optionally with region) code passed to speechConfig. `null` = auto. */
  code: string | null;
  /** Human readable name used inside the system instruction. */
  name: string;
  /** Label shown in the UI / diagnostics. */
  label: string;
}

export interface LanguageOption {
  code: string;
  label: string;
  name: string;
}

/**
 * Curated list of languages offered in the UI. The list is not a hard limit:
 * any syntactically valid ISO language tag supplied by a client is accepted by
 * `resolveLanguagePreference`, because the Live API supports more locales than
 * we want to hardcode here.
 */
export const SUPPORTED_LANGUAGES: readonly LanguageOption[] = [
  { code: '', label: 'Auto (follow the user)', name: 'the language spoken by the user' },
  { code: 'en-US', label: 'English (US)', name: 'English' },
  { code: 'en-GB', label: 'English (UK)', name: 'English' },
  { code: 'ar-SA', label: 'العربية (Arabic)', name: 'Arabic' },
  { code: 'es-ES', label: 'Español (Spanish)', name: 'Spanish' },
  { code: 'fr-FR', label: 'Français (French)', name: 'French' },
  { code: 'de-DE', label: 'Deutsch (German)', name: 'German' },
  { code: 'pt-BR', label: 'Português (Brazil)', name: 'Portuguese' },
  { code: 'it-IT', label: 'Italiano (Italian)', name: 'Italian' },
  { code: 'tr-TR', label: 'Türkçe (Turkish)', name: 'Turkish' },
  { code: 'ru-RU', label: 'Русский (Russian)', name: 'Russian' },
  { code: 'hi-IN', label: 'हिन्दी (Hindi)', name: 'Hindi' },
  { code: 'ur-PK', label: 'اردو (Urdu)', name: 'Urdu' },
  { code: 'id-ID', label: 'Bahasa Indonesia', name: 'Indonesian' },
  { code: 'ja-JP', label: '日本語 (Japanese)', name: 'Japanese' },
  { code: 'ko-KR', label: '한국어 (Korean)', name: 'Korean' },
  { code: 'zh-CN', label: '中文 (Mandarin)', name: 'Mandarin Chinese' },
];

// BCP-47-ish: primary subtag (2-3 letters) plus optional alphanumeric subtags.
const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export const AUTO_LANGUAGE: LanguagePreference = {
  code: null,
  name: 'the language spoken by the user',
  label: 'Auto (follow the user)',
};

/**
 * Normalizes a requested language.
 *
 * Invalid values are rejected (fall back to `auto`) rather than forwarded to
 * the API, where an unsupported tag would fail session setup.
 */
export function resolveLanguagePreference(requested?: string | null): LanguagePreference {
  if (!requested) return AUTO_LANGUAGE;
  const raw = requested.trim();
  if (!raw || raw.toLowerCase() === 'auto') return AUTO_LANGUAGE;
  if (!LANGUAGE_TAG_PATTERN.test(raw)) return AUTO_LANGUAGE;

  const known = SUPPORTED_LANGUAGES.find((l) => l.code.toLowerCase() === raw.toLowerCase());
  if (known) {
    return { code: known.code || null, name: known.name, label: known.label };
  }
  // Valid but not in the curated list: accept it and use the tag as the name.
  return { code: raw, name: raw, label: raw };
}

/**
 * Builds the language policy appended to the system instruction.
 *
 * IMPORTANT: an application-side instruction steers the model but cannot
 * *guarantee* compliance. For native-audio models (the default here) this is
 * the only supported language lever: Google documents that native-audio output
 * models choose the language themselves and do not support an explicit
 * `speechConfig.languageCode`. That field is only sent for legacy half-cascade
 * models where it is supported.
 */
export function buildLanguageInstruction(language: LanguagePreference): string {
  if (language.code) {
    return [
      'Language policy (highest priority, overrides every other instruction):',
      `Always speak and respond in ${language.name} (${language.code}) for the entire session.`,
      'Never switch to another language, even if the user speaks a different language,',
      "the transcript looks noisy, or you are interrupted. If the user's intent is unclear,",
      `ask for clarification in ${language.name}.`,
    ].join(' ');
  }
  return [
    "Language policy: The user has not locked a language. Detect the language of the user's",
    'first intelligible utterance in this session and keep using that same language for the',
    'rest of the session. Do not switch languages because of noisy or partial transcription.',
    'Only change language if the user explicitly asks you to.',
  ].join(' ');
}

/** Composes the final system instruction sent to the Live API. */
export function composeSystemInstruction(baseInstruction: string, language: LanguagePreference): string {
  const base = baseInstruction.trim();
  return `${base}${base ? '\n\n' : ''}${buildLanguageInstruction(language)}`;
}

/** Parses `gen_12` -> 12. Returns null for non-numeric/unknown IDs. */
export function generationOrdinal(generationId: string | null | undefined): number | null {
  if (!generationId) return null;
  const match = /^gen_(\d+)$/.exec(generationId);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}


/* ------------------------------------------------------------------------- */
/* Server-side generation attribution                                         */
/* ------------------------------------------------------------------------- */

/**
 * The Live API documents an interruption as `interrupted` followed by
 * `turnComplete` for the *same* turn ("When model is interrupted while
 * generating there will be no 'generation_complete' message in interrupted
 * turn, it will go through 'interrupted > turn_complete'").
 *
 * The bridge used to advance its generation counter on both events, so a
 * single barge-in consumed two generation IDs: one for the interrupted turn
 * and one empty "phantom" slot that the trailing `turnComplete` closed. When
 * `turnComplete` had already advanced the counter while the client was still
 * playing the generated audio, a later interruption was attributed to the
 * empty slot and the audible generation was never stopped.
 *
 * This helper decides which generation an interruption really refers to:
 * the last generation that produced content, not a reserved-but-empty slot.
 */
export interface InterruptionAttributionInput {
  currentGenerationId: string;
  /** Generation that last delivered audio or text, if any. */
  lastContentGenerationId: string | null;
  /** Generations already interrupted in this session. */
  alreadyInterrupted: readonly string[];
}

export interface InterruptionAttribution {
  interruptedGenerationId: string;
  /** Whether a new generation slot must be reserved for the next response. */
  advanceGeneration: boolean;
  /** True when this event repeats an interruption already handled. */
  duplicate: boolean;
  firstObservation: boolean;
}

export function resolveInterruptionAttribution(
  input: InterruptionAttributionInput
): InterruptionAttribution {
  const contentGenerationId = input.lastContentGenerationId;
  // The current slot only owns the interruption when it actually produced
  // content. Otherwise it is the reserved slot for the *next* response (a
  // `turnComplete` already ran while the previous audio was still playing).
  const attributedToCurrent =
    contentGenerationId === null || contentGenerationId === input.currentGenerationId;
  const interruptedGenerationId =
    contentGenerationId !== null && contentGenerationId !== input.currentGenerationId
      ? contentGenerationId
      : input.currentGenerationId;

  const duplicate = input.alreadyInterrupted.includes(interruptedGenerationId);
  return {
    interruptedGenerationId,
    // Duplicates must not consume another slot: an interrupted turn produces
    // exactly one interruption event for this application.
    advanceGeneration: attributedToCurrent && !duplicate,
    duplicate,
    firstObservation: !duplicate,
  };
}

export interface TurnCompletionInput {
  currentGenerationId: string;
  /** Whether the current (reserved) slot already delivered audio/text. */
  currentHasContent: boolean;
  /** Generation invalidated by the interruption that this turn_complete closes. */
  interruptedGenerationId: string | null;
}

export interface TurnCompletion {
  completedGenerationId: string;
  advanceGeneration: boolean;
  closesInterruptedTurn: boolean;
}

/**
 * Decides which generation a `turnComplete` closes.
 *
 * After an interruption the API sends `turnComplete` for the interrupted turn,
 * after the bridge has already reserved the next slot. That completion must
 * name the interrupted generation and must not advance the counter again.
 */
export function resolveTurnCompletion(input: TurnCompletionInput): TurnCompletion {
  if (input.interruptedGenerationId && !input.currentHasContent) {
    return {
      completedGenerationId: input.interruptedGenerationId,
      advanceGeneration: false,
      closesInterruptedTurn: true,
    };
  }
  return {
    completedGenerationId: input.currentGenerationId,
    advanceGeneration: true,
    closesInterruptedTurn: false,
  };
}


export type AudioRejectionReason = 'invalidated' | 'stale';

export interface AudioAcceptance {
  accepted: boolean;
  generationId: string;
  reason?: AudioRejectionReason;
}

/**
 * Single source of truth for "may this model audio chunk be played?".
 *
 * The gate distinguishes three things that the previous implementation
 * conflated into one mutable `currentGenerationId` ref:
 *
 *  1. `activeGenerationId` - the newest generation announced by the server
 *     (audio, interruption or turn_complete). It may be a *pending* generation
 *     with no audio yet.
 *  2. `generationsWithAudio` - generations that have actually produced audio.
 *  3. `playingGenerations` - generations that currently have scheduled audio.
 *
 * The distinction matters on barge-in: if `turn_complete` already moved the
 * active generation to the *next* (empty) generation while the previous
 * response is still audible, a local barge-in must invalidate the generation
 * being played - not the pending one that will carry the answer to the user's
 * new utterance.
 */
export class ConversationGate {
  private invalidatedGenerations = new Set<string>();
  private generationsWithAudio = new Set<string>();
  private playingGenerations = new Set<string>();
  /**
   * Number of scheduled-but-not-finished sources per generation.
   *
   * A generation is only "playing" while at least one of its chunks is still
   * audible. The previous implementation removed the generation from
   * `playingGenerations` on the *first* `markPlaybackEnded`, so a response
   * comprising many ~32 ms buffers appeared to stop playing after the first
   * buffer ended. That made local barge-in detection unreliable for the rest
   * of the response.
   */
  private playbackSourceCounts = new Map<string, number>();
  private pendingGenerationIds = new Set<string>();
  private activeGenerationId = INITIAL_GENERATION_ID;

  reset(): void {
    this.invalidatedGenerations.clear();
    this.generationsWithAudio.clear();
    this.playingGenerations.clear();
    this.playbackSourceCounts.clear();
    this.pendingGenerationIds.clear();
    this.activeGenerationId = INITIAL_GENERATION_ID;
  }

  get activeGeneration(): string {
    return this.activeGenerationId;
  }

  getActiveGenerationId(): string {
    return this.activeGenerationId;
  }

  isInvalidated(generationId: string): boolean {
    return this.invalidatedGenerations.has(generationId);
  }

  hasAudio(generationId: string): boolean {
    return this.generationsWithAudio.has(generationId);
  }

  isPlaying(generationId: string): boolean {
    return this.playingGenerations.has(generationId);
  }

  playbackCount(): number {
    return this.playingGenerations.size;
  }

  playing(): string[] {
    return [...this.playingGenerations];
  }

  invalidated(): string[] {
    return [...this.invalidatedGenerations];
  }

  /** Registers the next generation announced by the server (no audio yet). */
  noteNextGeneration(generationId: string | null | undefined): void {
    if (!generationId) return;
    const nextOrdinal = generationOrdinal(generationId);
    const activeOrdinal = generationOrdinal(this.activeGenerationId);
    if (nextOrdinal !== null && activeOrdinal !== null && nextOrdinal < activeOrdinal) {
      return; // Never move the active generation backwards.
    }
    this.activeGenerationId = generationId;
    if (!this.generationsWithAudio.has(generationId)) {
      this.pendingGenerationIds.add(generationId);
    }
  }

  /** Registers a generation known to exist but which has not produced audio. */
  seedGeneration(generationId: string): void {
    this.activeGenerationId = generationId;
    this.pendingGenerationIds.add(generationId);
  }

  /**
   * Decides whether a model audio chunk may be decoded and scheduled.
   * Also advances the active generation for accepted, newer chunks.
   */
  acceptAudio(generationId?: string | null): AudioAcceptance {
    if (!generationId) {
      // Legacy/unspecified generation: attribute it to the active generation,
      // but never resurrect a generation that was already invalidated.
      const active = this.activeGenerationId;
      if (this.invalidatedGenerations.has(active)) {
        return { accepted: false, generationId: active, reason: 'invalidated' };
      }
      return { accepted: true, generationId: active };
    }
    if (this.invalidatedGenerations.has(generationId)) {
      return { accepted: false, generationId, reason: 'invalidated' };
    }
    const chunkOrdinal = generationOrdinal(generationId);
    const activeOrdinal = generationOrdinal(this.activeGenerationId);
    if (chunkOrdinal !== null && activeOrdinal !== null && chunkOrdinal < activeOrdinal) {
      // Out-of-order delivery of a superseded turn.
      return { accepted: false, generationId, reason: 'stale' };
    }
    this.activeGenerationId = generationId;
    this.pendingGenerationIds.delete(generationId);
    this.generationsWithAudio.add(generationId);
    return { accepted: true, generationId };
  }

  markPlaybackScheduled(generationId: string): void {
    if (!generationId) return;
    this.generationsWithAudio.add(generationId);
    this.playingGenerations.add(generationId);
    this.playbackSourceCounts.set(
      generationId,
      (this.playbackSourceCounts.get(generationId) ?? 0) + 1
    );
  }

  markPlaybackEnded(generationId: string): void {
    const remaining = (this.playbackSourceCounts.get(generationId) ?? 0) - 1;
    if (remaining > 0) {
      this.playbackSourceCounts.set(generationId, remaining);
      return;
    }
    this.playbackSourceCounts.delete(generationId);
    this.playingGenerations.delete(generationId);
  }

  private addInvalidated(generationId: string): boolean {
    if (this.invalidatedGenerations.has(generationId)) return false;
    this.invalidatedGenerations.add(generationId);
    this.playingGenerations.delete(generationId);
    this.playbackSourceCounts.delete(generationId);
    return true;
  }

  /**
   * Local (client VAD) barge-in.
   *
   * Invalidates every generation with scheduled playback plus the active
   * generation *if it has already produced audio* (i.e. the model is still
   * streaming the response being interrupted). A pending generation announced
   * by `turn_complete` has no audio yet and must survive, otherwise the answer
   * to the barge-in itself would be dropped.
   */
  localBargeIn(): { invalidated: string[] } {
    const invalidated: string[] = [];
    for (const generationId of [...this.playingGenerations]) {
      if (this.addInvalidated(generationId)) invalidated.push(generationId);
    }
    this.playingGenerations.clear();
    this.playbackSourceCounts.clear();

    const active = this.activeGenerationId;
    const activeIsLiveResponse =
      this.generationsWithAudio.has(active) && !this.pendingGenerationIds.has(active);
    if (activeIsLiveResponse && this.addInvalidated(active)) {
      invalidated.push(active);
    }
    return { invalidated };
  }

  /**
   * Server-reported interruption. Invalidates exactly the generation the
   * server reported and adopts the server's next generation ID.
   *
   * A generation that is still scheduled for playback but is *older* than the
   * interrupted one can only be the tail of an obsolete response: the answer to
   * the interrupting utterance cannot reuse an earlier generation ID. Those
   * tails must be stopped too, otherwise a barge-in whose interruption event is
   * attributed to the server's newest (empty) slot leaves the audible tail of
   * the previous turn playing. Newer generations are never touched: they may be
   * the answer that already arrived out of order.
   */
  handleInterruption(
    interruptedGenerationId?: string | null,
    nextGenerationId?: string | null
  ): { invalidated: string[]; firstObservation: boolean; nextGenerationId: string } {
    const invalidated: string[] = [];
    let firstObservation = false;
    if (interruptedGenerationId) {
      const alreadyKnown = this.invalidatedGenerations.has(interruptedGenerationId);
      if (this.addInvalidated(interruptedGenerationId)) invalidated.push(interruptedGenerationId);
      firstObservation = !alreadyKnown;

      const interruptedOrdinal = generationOrdinal(interruptedGenerationId);
      if (interruptedOrdinal !== null) {
        for (const generationId of [...this.playingGenerations]) {
          const ordinal = generationOrdinal(generationId);
          if (ordinal !== null && ordinal < interruptedOrdinal) {
            if (this.addInvalidated(generationId)) invalidated.push(generationId);
          }
        }
      }
    }
    this.noteNextGeneration(nextGenerationId);
    return { invalidated, firstObservation, nextGenerationId: this.activeGenerationId };
  }

  /**
   * `turn_complete` only advances the active generation. It must not touch
   * playback bookkeeping: audio from that turn can still be playing locally.
   */
  handleTurnComplete(
    completedGenerationId?: string | null,
    nextGenerationId?: string | null
  ): { advanced: boolean; nextGenerationId: string } {
    const before = this.activeGenerationId;
    this.noteNextGeneration(nextGenerationId);
    void completedGenerationId;
    return { advanced: before !== this.activeGenerationId, nextGenerationId: this.activeGenerationId };
  }

  /** Session teardown: invalidate everything that could still reach the graph. */
  invalidateAll(): string[] {
    const invalidated: string[] = [];
    for (const generationId of [...this.playingGenerations]) {
      if (this.addInvalidated(generationId)) invalidated.push(generationId);
    }
    // Invalidate the active generation even if it is still pending (a
    // `turn_complete` may have advanced to a generation that has not produced
    // audio yet). Otherwise a late chunk for it would be accepted after
    // teardown.
    if (this.addInvalidated(this.activeGenerationId)) {
      invalidated.push(this.activeGenerationId);
    }
    this.playingGenerations.clear();
    this.playbackSourceCounts.clear();
    return invalidated;
  }
}



export interface AddAudioResult {
  turn: LedgerTurn;
  created: boolean;
}

/**
 * Ordered record of assistant turns keyed by generation ID.
 *
 * Previously the client mutated a single `currentTurnRef`, which meant a late
 * `turn_complete` for generation N could close the newer turn N+1. Looking up
 * by generation ID removes that ordering hazard.
 */
export class TurnLedger {
  private turnsNewestFirst: LedgerTurn[] = [];
  private byGeneration = new Map<string, LedgerTurn>();
  private counter = 0;

  constructor(private readonly nowUtc: () => string = () => new Date().toISOString()) {}

  clear(): void {
    this.turnsNewestFirst = [];
    this.byGeneration.clear();
    this.counter = 0;
  }

  addAudio(
    generationId: string | undefined,
    durationMs: number,
    options: { latencyMs?: number } = {}
  ): AddAudioResult {
    const gen = generationId || `${INITIAL_GENERATION_ID}_unlabeled`;
    let turn = this.byGeneration.get(gen);

    // A turn that already ended must not absorb audio from a re-used
    // generation ID: start a fresh ledger entry instead.
    if (turn && turn.status !== 'responding') {
      turn = undefined;
    }

    if (!turn) {
      this.counter += 1;
      turn = {
        id: `turn-${this.counter}-${gen}`,
        generationId: gen,
        turnNumber: this.counter,
        startTimeUtc: this.nowUtc(),
        text: '',
        audioChunksCount: 1,
        totalAudioDurationMs: Math.round(durationMs),
        status: 'responding',
      };
      if (options.latencyMs !== undefined) {
        turn.firstAudioLatencyMs = options.latencyMs;
      }
      this.byGeneration.set(gen, turn);
      this.turnsNewestFirst.unshift(turn);
      return { turn: this.clone(turn), created: true };
    }

    turn.audioChunksCount += 1;
    turn.totalAudioDurationMs += Math.round(durationMs);
    if (turn.firstAudioLatencyMs === undefined && options.latencyMs !== undefined) {
      turn.firstAudioLatencyMs = options.latencyMs;
    }
    return { turn: this.clone(turn), created: false };
  }

  appendText(generationId: string | undefined, text: string): LedgerTurn | null {
    if (!generationId || !text) return null;
    let turn = this.byGeneration.get(generationId);

    // Transcript parts can arrive before the first audio chunk; create the
    // turn so the assistant's text is not silently discarded.
    if (!turn || turn.status !== 'responding') {
      this.counter += 1;
      turn = {
        id: `turn-${this.counter}-${generationId}`,
        generationId,
        turnNumber: this.counter,
        startTimeUtc: this.nowUtc(),
        text: '',
        audioChunksCount: 0,
        totalAudioDurationMs: 0,
        status: 'responding',
      };
      this.byGeneration.set(generationId, turn);
      this.turnsNewestFirst.unshift(turn);
    }

    turn.text += text;
    return this.clone(turn);
  }

  complete(generationId?: string | null): boolean {
    return this.transition(generationId, 'completed');
  }

  interrupt(generationId?: string | null): boolean {
    return this.transition(generationId, 'interrupted');
  }

  private transition(generationId: string | null | undefined, status: TurnStatus): boolean {
    if (!generationId) return false;
    const turn = this.byGeneration.get(generationId);
    if (!turn || turn.status !== 'responding') return false;
    turn.status = status;
    return true;
  }

  get(generationId: string | undefined): LedgerTurn | null {
    if (!generationId) return null;
    const turn = this.byGeneration.get(generationId);
    return turn ? this.clone(turn) : null;
  }

  size(): number {
    return this.turnsNewestFirst.length;
  }

  snapshot(): LedgerTurn[] {
    return this.turnsNewestFirst.map((turn) => this.clone(turn));
  }

  private clone(turn: LedgerTurn): LedgerTurn {
    return { ...turn };
  }
}

/* ------------------------------------------------------------------------- */
/* Playback-cancellation and barge-in policy                                  */
/* ------------------------------------------------------------------------- */

export type CancellationReason = 'local_onset' | 'server_interrupted' | 'session_cleanup';

/**
 * Returns the generations whose scheduled audio must be stopped.
 *
 * - `session_cleanup` stops everything that was scheduled.
 * - `local_onset` / `server_interrupted` stop exactly the generations that
 *   were invalidated for that event. This matters when a newer generation has
 *   already been scheduled (out-of-order delivery): cancelling the old
 *   generation must not truncate the answer that replaced it.
 */
export function resolvePlaybackStopSet(
  reason: CancellationReason,
  invalidatedGenerations: readonly string[],
  scheduledGenerations: readonly string[]
): Set<string> {
  if (reason === 'session_cleanup') return new Set(scheduledGenerations);
  return new Set(invalidatedGenerations);
}

export interface LocalBargeInInput {
  isSpeaking: boolean;
  speechFrameCount: number;
  playbackCount: number;
  alreadyCancelled: boolean;
  /**
   * Set after a barge-in until the user has been silent for at least one
   * analysis frame. Prevents the same continuous utterance from cancelling
   * the model's *answer* as soon as its first chunk becomes audible.
   */
  suppressedUntilSilence: boolean;
  onsetFrames?: number;
}

/**
 * Decides whether microphone activity should locally stop playback.
 *
 * `alreadyCancelled` only re-arms at a turn boundary; `suppressedUntilSilence`
 * additionally requires a pause, which is what prevents the answer to a
 * barge-in from being cancelled by the tail of the interrupting utterance.
 */
export function shouldTriggerLocalBargeIn(input: LocalBargeInInput): boolean {
  const onsetFrames = input.onsetFrames ?? 3;
  return (
    input.isSpeaking &&
    input.speechFrameCount >= onsetFrames &&
    input.playbackCount > 0 &&
    !input.alreadyCancelled &&
    !input.suppressedUntilSilence
  );
}
