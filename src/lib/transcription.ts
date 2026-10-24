/**
 * Server→client transcription classification.
 *
 * RECONSTRUCTED (Stage 5): the original Stage 3 `transcription.ts` could not be
 * recovered. This module extracts the classification the surviving bridge
 * already performed inline (`handleServerMessage`), so the mapping is testable
 * without a live Gemini session.
 *
 * Rules encoded here:
 *  - Interim and final input transcription are distinct events; a cumulative
 *    interim replaces the previous hypothesis on the client, a final utterance is
 *    appended once.
 *  - Output transcription belongs to the generation that was current when the
 *    frame started, never to the generation that a later `turnComplete` in the
 *    same frame reserves.
 *  - Output text with no generation attribution is dropped, never guessed.
 *  - Output text coalesced with an interruption is a stale tail and is dropped.
 *  - No confidence value is invented: the Live API does not provide one.
 */

export interface TranscriptTextLike {
  text?: string;
}

export interface TranscriptionSourceLike {
  interimInputTranscription?: TranscriptTextLike | null;
  inputTranscription?: TranscriptTextLike | null;
  outputTranscription?: TranscriptTextLike | null;
}

export interface InterimInputTranscriptionEvent {
  direction: 'input';
  isFinal: false;
  text: string;
}

export interface FinalInputTranscriptionEvent {
  direction: 'input';
  isFinal: true;
  text: string;
}

export interface OutputTranscriptionEvent {
  direction: 'output';
  isFinal: true;
  /** Empty output text is dropped, so this is always a real generation id. */
  generationId: string;
  text: string;
}

export type ServerTranscriptionEvent =
  | InterimInputTranscriptionEvent
  | FinalInputTranscriptionEvent
  | OutputTranscriptionEvent;

export interface ClassifyTranscriptionOptions {
  /**
   * Generation that owns content in this frame, captured before a terminal
   * event advances the counter. Required for output attribution.
   */
  frameGenerationId?: string | null;
  /** True when the same server frame also carries `interrupted: true`. */
  interruptedInFrame?: boolean;
}

export interface ClassifiedTranscriptions {
  events: ServerTranscriptionEvent[];
  /** Output text dropped because it had no generation attribution. */
  droppedUnattributedOutput: number;
  /** Output text dropped because it arrived with an interruption flag. */
  droppedInterruptedOutput: number;
}

export function classifyServerTranscription(
  source: TranscriptionSourceLike | null | undefined,
  options: ClassifyTranscriptionOptions = {}
): ClassifiedTranscriptions {
  const events: ServerTranscriptionEvent[] = [];
  let droppedUnattributedOutput = 0;
  let droppedInterruptedOutput = 0;

  if (!source) return { events, droppedUnattributedOutput, droppedInterruptedOutput };

  // 1. Customer speech: interim hypothesis while the customer is speaking.
  const interim = source.interimInputTranscription?.text;
  if (interim) {
    events.push({ direction: 'input', isFinal: false, text: interim });
  }

  // 2. Customer speech: finalized utterance segment.
  const final = source.inputTranscription?.text;
  if (final) {
    events.push({ direction: 'input', isFinal: true, text: final });
  }

  // 3. Private sales copilot suggestion text.
  const output = source.outputTranscription?.text;
  if (output) {
    if (options.interruptedInFrame) {
      droppedInterruptedOutput += 1;
    } else if (!options.frameGenerationId) {
      droppedUnattributedOutput += 1;
    } else {
      events.push({
        direction: 'output',
        isFinal: true,
        generationId: options.frameGenerationId,
        text: output,
      });
    }
  }

  return { events, droppedUnattributedOutput, droppedInterruptedOutput };
}
