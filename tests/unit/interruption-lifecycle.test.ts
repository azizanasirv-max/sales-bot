import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationLifecycle, mapServerContent } from '../../src/lib/generationLifecycle';
import { classifyServerTranscription } from '../../src/lib/transcription';
import {
  ConversationGate,
  CustomerTranscriptLedger,
  SalesSuggestionLedger,
  isStaleTransportEpoch,
} from '../../src/lib/conversation';

/**
 * Integration tests for the bridge's server-content mapping.
 *
 * These drive `mapServerContent` — the exact function `server.ts` calls for each
 * Gemini frame — and assert the frames the browser would receive. They are not
 * a test-only re-implementation of lifecycle rules.
 */

const OPTIONS = {
  sessionId: 'session-test',
  serverMono: 1234.5,
  serverUtc: '2026-10-24T00:00:00.000Z',
};

function map(content: Parameters<typeof mapServerContent>[0], lifecycle: GenerationLifecycle) {
  return mapServerContent(content, lifecycle, OPTIONS);
}

function frameOfType(frames: Record<string, unknown>[], type: string): Record<string, any> {
  const frame = frames.find((candidate) => candidate.type === type);
  assert.ok(frame, `expected a ${type} frame in ${JSON.stringify(frames)}`);
  return frame as Record<string, any>;
}

test('frames: normal uninterrupted completion emits text then one completion', () => {
  const lifecycle = new GenerationLifecycle();

  const content = map({ modelTurn: { parts: [{ text: 'Pitch annual billing.' }] } }, lifecycle);
  assert.deepEqual(content.frames.map((frame) => frame.type), ['text']);
  assert.equal(frameOfType(content.frames, 'text').generationId, 'gen_1');

  const completion = map({ turnComplete: true }, lifecycle);
  assert.deepEqual(completion.frames.map((frame) => frame.type), ['turn_complete']);
  const done = frameOfType(completion.frames, 'turn_complete');
  assert.equal(done.completedGenerationId, 'gen_1');
  assert.equal(done.nextGenerationId, 'gen_2');
  assert.equal(done.closesInterruptedTurn, false);
  assert.equal(done.duplicate, false);
  assert.equal(done.completedTurnsCount, 1);

  const next = map({ modelTurn: { parts: [{ text: 'Ask about volume.' }] } }, lifecycle);
  assert.equal(frameOfType(next.frames, 'text').generationId, 'gen_2');
});

test('frames: interruption followed by completion closes the interrupted generation once', () => {
  const lifecycle = new GenerationLifecycle();
  map({ modelTurn: { parts: [{ text: 'Long pitch' }] } }, lifecycle);

  const interruption = map({ interrupted: true }, lifecycle);
  const interrupted = frameOfType(interruption.frames, 'interrupted');
  assert.equal(interrupted.interruptedGenerationId, 'gen_1');
  assert.equal(interrupted.nextGenerationId, 'gen_2');
  assert.equal(interrupted.duplicate, false);
  assert.equal(interrupted.serverInterruptionCount, 1);

  const completion = map({ turnComplete: true }, lifecycle);
  const done = frameOfType(completion.frames, 'turn_complete');
  assert.equal(done.completedGenerationId, 'gen_1');
  assert.equal(done.closesInterruptedTurn, true);
  assert.equal(done.nextGenerationId, 'gen_2');
  assert.equal(done.completedTurnsCount, 0);

  assert.equal(lifecycle.currentGenerationId, 'gen_2');
});

test('frames: duplicate interruptions are idempotent and emit no extra slot', () => {
  const lifecycle = new GenerationLifecycle();
  map({ modelTurn: { parts: [{ text: 'Pitch' }] } }, lifecycle);
  map({ interrupted: true }, lifecycle);

  const duplicate = map({ interrupted: true }, lifecycle);
  const frame = frameOfType(duplicate.frames, 'interrupted');
  assert.equal(frame.duplicate, true);
  assert.equal(frame.interruptedGenerationId, 'gen_1');
  assert.equal(frame.nextGenerationId, 'gen_2');
  assert.equal(frame.serverInterruptionCount, 1);
  assert.equal(lifecycle.currentGenerationId, 'gen_2');
});

test('frames: content and turnComplete in one frame belong to the same generation', () => {
  const lifecycle = new GenerationLifecycle();
  const mapped = map(
    { modelTurn: { parts: [{ text: 'Final words' }] }, turnComplete: true },
    lifecycle
  );

  assert.deepEqual(mapped.frames.map((frame) => frame.type), ['text', 'turn_complete']);
  assert.equal(frameOfType(mapped.frames, 'text').generationId, 'gen_1');
  const done = frameOfType(mapped.frames, 'turn_complete');
  assert.equal(done.completedGenerationId, 'gen_1');
  assert.equal(done.nextGenerationId, 'gen_2');

  const lifecycle2 = new GenerationLifecycle();
  const mapped2 = map(
    { outputTranscription: { text: 'Transcript tail' }, turnComplete: true },
    lifecycle2
  );
  assert.equal(frameOfType(mapped2.frames, 'transcription').generationId, 'gen_1');
});

test('frames: late content coalesced with an interruption is dropped as a stale tail', () => {
  const lifecycle = new GenerationLifecycle();
  map({ modelTurn: { parts: [{ text: 'Audible pitch' }] } }, lifecycle);

  const tail = map(
    {
      interrupted: true,
      modelTurn: { parts: [{ text: ' stale tail' }, { inlineData: { data: 'AAAA' } }] },
      outputTranscription: { text: ' late transcript' },
    },
    lifecycle
  );

  assert.deepEqual(tail.frames.map((frame) => frame.type), ['interrupted']);
  assert.equal(tail.contentPartsDroppedAfterInterrupt, 2);
  assert.equal(tail.modelChunksReceived, 1);
  assert.equal(tail.outputTranscriptionsDropped, 1);

  const answer = map({ modelTurn: { parts: [{ text: 'Try the annual plan' }] } }, lifecycle);
  assert.equal(frameOfType(answer.frames, 'text').generationId, 'gen_2');
});

test('frames: a duplicate completion cannot advance state twice', () => {
  const lifecycle = new GenerationLifecycle();
  map({ modelTurn: { parts: [{ text: 'Pitch' }] } }, lifecycle);
  map({ turnComplete: true }, lifecycle);
  assert.equal(lifecycle.currentGenerationId, 'gen_2');

  const duplicate = map({ turnComplete: true }, lifecycle);
  const done = frameOfType(duplicate.frames, 'turn_complete');
  assert.equal(done.duplicate, true);
  assert.equal(done.completedGenerationId, 'gen_1');
  assert.equal(done.nextGenerationId, 'gen_2');
  assert.equal(lifecycle.currentGenerationId, 'gen_2');
});

test('frames: interruption after completion targets the audible generation, not the reserved slot', () => {
  const lifecycle = new GenerationLifecycle();
  map({ modelTurn: { parts: [{ text: 'Pitch' }] } }, lifecycle);
  map({ turnComplete: true }, lifecycle);

  const interruption = map({ interrupted: true }, lifecycle);
  const frame = frameOfType(interruption.frames, 'interrupted');
  assert.equal(frame.interruptedGenerationId, 'gen_1');
  assert.equal(frame.nextGenerationId, 'gen_2');
  assert.equal(lifecycle.currentGenerationId, 'gen_2');
});

test('frames: audio-only content and content-less completions create no suggestion record', () => {
  const lifecycle = new GenerationLifecycle();
  const mapped = map({ modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } }, lifecycle);
  assert.equal(mapped.modelChunksReceived, 1);
  assert.equal(mapped.modelChunksDropped, 1);
  assert.equal(mapped.frames.length, 0);

  // Audio-only turn: the generation exists (a real response), but the client
  // ledger stays empty because no suggestion text was emitted.
  const ledger = new SalesSuggestionLedger(10);
  assert.equal(ledger.size(), 0);
  const completion = map({ turnComplete: true }, lifecycle);
  const done = frameOfType(completion.frames, 'turn_complete');
  assert.equal(done.completedGenerationId, 'gen_1');
  assert.equal(done.completedTurnsCount, 1);

  // A terminal event with no content at all must not create a generation.
  const empty = new GenerationLifecycle();
  const emptyCompletion = map({ turnComplete: true }, empty);
  assert.equal(empty.currentGenerationId, 'gen_0');
  assert.equal(empty.completedTurns, 0);
  assert.equal(frameOfType(emptyCompletion.frames, 'turn_complete').completedGenerationId, 'gen_0');
});

test('transcription: interim and final input events are distinct, without invented confidence', () => {
  const lifecycle = new GenerationLifecycle();
  const mapped = map(
    {
      interimInputTranscription: { text: 'inter' },
      inputTranscription: { text: 'interim hypothesis' },
    },
    lifecycle
  );
  const events = mapped.frames.filter((frame) => frame.type === 'transcription');
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => [event.direction, event.isFinal]),
    [
      ['input', false],
      ['input', true],
    ]
  );
  for (const event of events) {
    assert.equal('confidence' in event, false);
  }
});

test('transcription: repeated finals do not duplicate a customer turn', () => {
  const ledger = new CustomerTranscriptLedger(10);
  const events = classifyServerTranscription({ inputTranscription: { text: 'We need a quote' } });
  assert.equal(events.events.length, 1);

  assert.equal(ledger.addFinal('We need a quote', 1000).added, true);
  assert.equal(ledger.addFinal('We need a quote', 1200).added, false);
  // Outside the dedupe window the same words are a new utterance, not a repeat.
  assert.equal(ledger.addFinal('We need a quote', 9000).added, true);
  assert.equal(ledger.size(), 2);
  assert.equal(ledger.getInterim(), null);
});

test('transcription: output text without attribution or after interruption is dropped', () => {
  const unattributed = classifyServerTranscription(
    { outputTranscription: { text: 'orphan' } },
    {}
  );
  assert.equal(unattributed.events.length, 0);
  assert.equal(unattributed.droppedUnattributedOutput, 1);

  const interrupted = classifyServerTranscription(
    { outputTranscription: { text: 'stale' } },
    { frameGenerationId: 'gen_1', interruptedInFrame: true }
  );
  assert.equal(interrupted.events.length, 0);
  assert.equal(interrupted.droppedInterruptedOutput, 1);

  const ledger = new SalesSuggestionLedger(10);
  assert.equal(ledger.appendDelta(undefined, 'orphan').unattributed, true);
  assert.equal(ledger.size(), 0);
});

test('sessions: stale transport epochs and reset isolate a new session lifecycle', () => {
  assert.equal(isStaleTransportEpoch(4, 3), true);
  assert.equal(isStaleTransportEpoch(4, 4), false);

  const lifecycle = new GenerationLifecycle();
  map({ modelTurn: { parts: [{ text: 'Old session pitch' }] } }, lifecycle);
  map({ interrupted: true }, lifecycle);

  lifecycle.reset();
  assert.equal(lifecycle.currentGenerationId, 'gen_0');
  assert.equal(lifecycle.lastContentGenerationId, null);
  assert.equal(lifecycle.interruptionCount, 0);
  assert.equal(lifecycle.pendingInterruptedGenerationId, null);

  const interruption = map({ interrupted: true }, lifecycle);
  const frame = frameOfType(interruption.frames, 'interrupted');
  assert.equal(frame.interruptedGenerationId, 'gen_0');
  assert.equal(frame.duplicate, false);
  assert.equal(lifecycle.currentGenerationId, 'gen_1');
});


test('frames: suggestion text is delivered before the terminal event that closes it', () => {
  const lifecycle = new GenerationLifecycle();
  const mapped = map(
    { outputTranscription: { text: 'Offer a trial' }, turnComplete: true },
    lifecycle
  );

  // Wire order must be content first, terminal last: a terminal event advances
  // the client's active generation, which would make correctly-attributed text
  // look stale if it arrived afterwards.
  assert.deepEqual(mapped.frames.map((frame) => frame.type), [
    'transcription',
    'turn_complete',
  ]);

  // Drive the real client-side ledgers in that order.
  const gate = new ConversationGate();
  const ledger = new SalesSuggestionLedger(10);
  for (const rawFrame of mapped.frames) {
    const frame = rawFrame as Record<string, any>;
    if (frame.type === 'transcription' && frame.direction === 'output') {
      const result = ledger.appendDelta(frame.generationId, frame.text);
      assert.equal(result.created, true);
      assert.equal(frame.generationId, 'gen_1');
    } else if (frame.type === 'turn_complete') {
      gate.handleTurnComplete(frame.completedGenerationId, frame.nextGenerationId);
      ledger.completeTurn(frame.completedGenerationId);
    }
  }

  assert.equal(ledger.getLatest()?.text, 'Offer a trial');
  assert.equal(ledger.getLatest()?.status, 'completed');
  assert.equal(gate.getActiveGenerationId(), 'gen_2');
});
