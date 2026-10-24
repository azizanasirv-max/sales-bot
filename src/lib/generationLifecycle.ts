/**
 * Server-side generation lifecycle and Gemini-frame → client-frame mapping.
 *
 * RECONSTRUCTED (Stage 5): the original Stage 3 `generationLifecycle.ts` could
 * not be recovered from any Git reference, Cline artifact or filesystem
 * location. This module consolidates the generation rules that the surviving
 * bridge enforced inline (and that Stage 4 had already hardened) into a single
 * state authority, plus a pure mapping function that turns one
 * `LiveServerMessage.serverContent` into the frames sent to the browser.
 *
 * Putting the mapping here means the interruption/completion sequences are
 * exercised by tests through the *same* code the server runs, rather than a
 * test-only re-implementation.
 */

import {
  INITIAL_GENERATION_ID,
  resolveInterruptionAttribution,
  resolveTurnCompletion,
} from './conversation';
import { classifyServerTranscription, type TranscriptionSourceLike } from './transcription';

export interface ModelPartLike {
  text?: string;
  inlineData?: { data?: string; mimeType?: string } | null;
}

export interface ServerContentLike extends TranscriptionSourceLike {
  interrupted?: boolean;
  turnComplete?: boolean;
  modelTurn?: { parts?: ModelPartLike[] } | null;
}

export interface GenerationInterruptionOutcome {
  interruptedGenerationId: string;
  nextGenerationId: string;
  /** True when this repeats an interruption already applied. */
  duplicate: boolean;
  firstObservation: boolean;
  advanceGeneration: boolean;
  interruptionCount: number;
}

export interface GenerationCompletionOutcome {
  completedGenerationId: string;
  nextGenerationId: string;
  advanceGeneration: boolean;
  closesInterruptedTurn: boolean;
  duplicate: boolean;
  completedTurns: number;
}

/**
 * Single authority for generation IDs on the bridge.
 *
 * `currentGenerationId` is the slot the next response will use. It may be a
 * reserved, content-less slot after `turnComplete`. `lastContentGenerationId`
 * is the last slot that actually produced content and is the only valid
 * attribution target for an interruption.
 */
export class GenerationLifecycle {
  private counter = 0;
  private current = INITIAL_GENERATION_ID;
  private lastContent: string | null = null;
  private interruptedGenerations = new Set<string>();
  private pendingInterruptedGeneration: string | null = null;
  private closedGenerations = new Set<string>();
  private interruptionCounter = 0;
  private completedTurnCounter = 0;

  get currentGenerationId(): string {
    return this.current;
  }

  get lastContentGenerationId(): string | null {
    return this.lastContent;
  }

  get interruptionCount(): number {
    return this.interruptionCounter;
  }

  get completedTurns(): number {
    return this.completedTurnCounter;
  }

  /** Interrupted generation whose trailing `turnComplete` is still expected. */
  get pendingInterruptedGenerationId(): string | null {
    return this.pendingInterruptedGeneration;
  }

  private nextGeneration(): string {
    this.counter += 1;
    this.current = `gen_${this.counter}`;
    return this.current;
  }

  /**
   * Marks the current slot as producing content (advancing off `gen_0` on the
   * first response), and returns the generation that owns the content.
   */
  noteContent(): string {
    if (this.current === INITIAL_GENERATION_ID) this.nextGeneration();
    this.lastContent = this.current;
    return this.current;
  }

  /**
   * Records content for a generation that was attributed before a terminal
   * event advanced the counter (e.g. an output transcript in a frame that also
   * carried `turnComplete`).
   */
  noteContentFor(generationId: string): void {
    if (!generationId) return;
    this.lastContent = generationId;
  }

  interrupt(): GenerationInterruptionOutcome {
    const attribution = resolveInterruptionAttribution({
      currentGenerationId: this.current,
      lastContentGenerationId: this.lastContent,
      alreadyInterrupted: [...this.interruptedGenerations],
    });

    if (!attribution.duplicate) {
      this.interruptedGenerations.add(attribution.interruptedGenerationId);
      this.pendingInterruptedGeneration = attribution.interruptedGenerationId;
      this.interruptionCounter += 1;
    }
    if (attribution.advanceGeneration) this.nextGeneration();

    return {
      interruptedGenerationId: attribution.interruptedGenerationId,
      nextGenerationId: this.current,
      duplicate: attribution.duplicate,
      firstObservation: attribution.firstObservation,
      advanceGeneration: attribution.advanceGeneration,
      interruptionCount: this.interruptionCounter,
    };
  }

  complete(): GenerationCompletionOutcome {
    const completion = resolveTurnCompletion({
      currentGenerationId: this.current,
      currentHasContent: this.lastContent === this.current,
      interruptedGenerationId: this.pendingInterruptedGeneration,
      lastContentGenerationId: this.lastContent,
      alreadyClosedGenerationIds: [...this.closedGenerations],
    });

    if (completion.advanceGeneration) {
      this.nextGeneration();
      this.completedTurnCounter += 1;
    }
    if (completion.advanceGeneration || completion.closesInterruptedTurn) {
      this.closedGenerations.add(completion.completedGenerationId);
    }
    this.pendingInterruptedGeneration = null;

    return {
      ...completion,
      nextGenerationId: this.current,
      completedTurns: this.completedTurnCounter,
    };
  }

  /** Full reset for a brand-new session (never shared between sessions). */
  reset(): void {
    this.counter = 0;
    this.current = INITIAL_GENERATION_ID;
    this.lastContent = null;
    this.interruptedGenerations.clear();
    this.pendingInterruptedGeneration = null;
    this.closedGenerations.clear();
    this.interruptionCounter = 0;
    this.completedTurnCounter = 0;
  }
}

export interface MapServerContentOptions {
  sessionId: string;
  serverMono: number;
  serverUtc: string;
}

export interface MappedServerFrames {
  frames: Record<string, unknown>[];
  /** Model audio parts seen in this frame (never forwarded to the browser). */
  modelChunksReceived: number;
  /** Model audio parts deliberately not forwarded (no-audio-playback build). */
  modelChunksDropped: number;
  /** Content parts dropped as the stale tail of an interrupted response. */
  contentPartsDroppedAfterInterrupt: number;
  /** Output transcripts dropped for lack of attribution or after interruption. */
  outputTranscriptionsDropped: number;
}

const EMPTY_FRAME_COUNTS: Omit<MappedServerFrames, 'frames'> = {
  modelChunksReceived: 0,
  modelChunksDropped: 0,
  contentPartsDroppedAfterInterrupt: 0,
  outputTranscriptionsDropped: 0,
};

/**
 * Maps one `serverContent` frame into the exact client frames the bridge emits.
 *
 * Ordering matches the live bridge: interruption first (so a reserved slot is
 * known), then model content, then `turnComplete`, then transcripts. Content
 * and output text that share a frame with `interrupted` are the stale tail of
 * the interrupted response and are dropped.
 */
export function mapServerContent(
  serverContent: ServerContentLike | null | undefined,
  lifecycle: GenerationLifecycle,
  options: MapServerContentOptions
): MappedServerFrames {
  if (!serverContent) {
    return { frames: [], ...EMPTY_FRAME_COUNTS };
  }

  const frames: Record<string, unknown>[] = [];
  const { sessionId, serverMono, serverUtc } = options;
  let modelChunksReceived = 0;
  let modelChunksDropped = 0;
  let contentPartsDroppedAfterInterrupt = 0;

  const interruptedInFrame = Boolean(serverContent.interrupted);

  // 1. Interruption attribution / reservation.
  if (interruptedInFrame) {
    const outcome = lifecycle.interrupt();
    frames.push({
      type: 'interrupted',
      sessionId,
      interruptedGenerationId: outcome.interruptedGenerationId,
      nextGenerationId: outcome.nextGenerationId,
      duplicate: outcome.duplicate,
      serverInterruptionCount: outcome.interruptionCount,
    });
  }

  // Generation that owns content in this frame, captured before `turnComplete`
  // may advance the counter.
  let frameGenerationId = lifecycle.currentGenerationId;
  const outputText = serverContent.outputTranscription?.text;

  // 2. Model content: audio is counted but never forwarded (text-only build).
  const parts = serverContent.modelTurn?.parts;
  if (parts?.length) {
    if (interruptedInFrame) {
      contentPartsDroppedAfterInterrupt += parts.length;
      modelChunksReceived += parts.filter((part) => part.inlineData?.data).length;
    } else {
      frameGenerationId = lifecycle.noteContent();
      for (const part of parts) {
        if (part.inlineData?.data) {
          modelChunksReceived += 1;
          modelChunksDropped += 1;
        }
        if (part.text) {
          frames.push({
            type: 'text',
            sessionId,
            generationId: frameGenerationId,
            text: part.text,
            serverMono,
            serverUtc,
          });
        }
      }
    }
  } else if (outputText && !interruptedInFrame) {
    // An output transcript is model content too. Establish its generation
    // before the terminal event in this frame reserves the next slot.
    frameGenerationId = lifecycle.noteContent();
  }

  // 3. Transcripts (input interim/final + attributed, non-stale output).
  const transcribed = classifyServerTranscription(serverContent, {
    frameGenerationId,
    interruptedInFrame,
  });
  const outputTranscriptionsDropped =
    transcribed.droppedInterruptedOutput + transcribed.droppedUnattributedOutput;

  for (const event of transcribed.events) {
    if (event.direction === 'output') {
      // Output text is content for attribution purposes and is sent *before*
      // the terminal event below, so the client can attach it to this
      // generation and complete that record instead of rejecting it as stale.
      lifecycle.noteContentFor(event.generationId);
      frames.push({
        type: 'transcription',
        sessionId,
        direction: 'output',
        isFinal: true,
        generationId: event.generationId,
        text: event.text,
        serverMono,
        serverUtc,
      });
    } else {
      frames.push({
        type: 'transcription',
        sessionId,
        direction: 'input',
        isFinal: event.isFinal,
        text: event.text,
        serverMono,
        serverUtc,
      });
    }
  }

  // 4. Terminal event for the turn, last so content in the same frame is
  //    delivered (and attributed) before the turn is closed.
  if (serverContent.turnComplete) {
    const completion = lifecycle.complete();
    frames.push({
      type: 'turn_complete',
      sessionId,
      completedGenerationId: completion.completedGenerationId,
      nextGenerationId: completion.nextGenerationId,
      completedTurnsCount: completion.completedTurns,
      closesInterruptedTurn: completion.closesInterruptedTurn,
      duplicate: completion.duplicate,
    });
  }

  return {
    frames,
    modelChunksReceived,
    modelChunksDropped,
    contentPartsDroppedAfterInterrupt,
    outputTranscriptionsDropped,
  };
}
