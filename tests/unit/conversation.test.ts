import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConversationGate,
  TurnLedger,
  CustomerTranscriptLedger,
  SalesSuggestionLedger,
  buildLanguageInstruction,
  composeSystemInstruction,
  isStaleTransportEpoch,
  resolveInterruptionAttribution,
  resolveLanguagePreference,
  resolvePlaybackStopSet,
  resolveTurnCompletion,
  shouldTriggerLocalBargeIn,
} from '../../src/lib/conversation';

test('language: empty/invalid values fall back to auto (never a broken API tag)', () => {
  assert.equal(resolveLanguagePreference(undefined).code, null);
  assert.equal(resolveLanguagePreference('').code, null);
  assert.equal(resolveLanguagePreference('auto').code, null);
  assert.equal(resolveLanguagePreference('english please!').code, null);
  assert.equal(resolveLanguagePreference('../etc/passwd').code, null);
});

test('language: curated and valid-but-unknown tags are preserved', () => {
  assert.deepEqual(resolveLanguagePreference('en-US'), {
    code: 'en-US',
    name: 'English',
    label: 'English (US)',
  });
  // Case-insensitive match to the curated list.
  assert.equal(resolveLanguagePreference('ar-sa').code, 'ar-SA');
  // Syntactically valid but not curated: kept as the tag.
  assert.equal(resolveLanguagePreference('sv-SE').code, 'sv-SE');
});

test('language: a locked language produces explicit no-switch instructions', () => {
  const instruction = buildLanguageInstruction(resolveLanguagePreference('ar-SA'));
  assert.match(instruction, /Language policy/);
  assert.match(instruction, /Arabic/);
  assert.match(instruction, /ar-SA/);
  assert.match(instruction, /Never switch to another language/i);

  const auto = buildLanguageInstruction(resolveLanguagePreference(''));
  assert.match(auto, /first intelligible utterance/i);
  assert.doesNotMatch(auto, /Never switch to another language/i);
});

test('language: the policy is appended to (and cannot replace) the base instruction', () => {
  const composed = composeSystemInstruction('Be concise.', resolveLanguagePreference('en-US'));
  assert.match(composed, /^Be concise\./);
  assert.match(composed, /Always speak and respond in English/);
});

test('gate: normal turn audio is accepted in order', () => {
  const gate = new ConversationGate();
  assert.equal(gate.acceptAudio('gen_1').accepted, true);
  assert.equal(gate.getActiveGenerationId(), 'gen_1');
  gate.handleTurnComplete('gen_1', 'gen_2');
  assert.equal(gate.getActiveGenerationId(), 'gen_2');
  assert.equal(gate.acceptAudio('gen_2').accepted, true);
});

test('gate: out-of-order audio from an older generation is rejected as stale', () => {
  const gate = new ConversationGate();
  gate.acceptAudio('gen_3');
  const result = gate.acceptAudio('gen_2');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'stale');
});

test('gate: barge-in after turn_complete must not invalidate the pending answer', () => {
  const gate = new ConversationGate();
  // Turn 1 audio is still playing when the model reports turn_complete.
  gate.acceptAudio('gen_1');
  gate.markPlaybackScheduled('gen_1');
  gate.handleTurnComplete('gen_1', 'gen_2');

  const bargeIn = gate.localBargeIn();

  // The audible generation is stopped/invalidated...
  assert.deepEqual(bargeIn.invalidated, ['gen_1']);
  assert.equal(gate.isInvalidated('gen_1'), true);
  // ...but gen_2 is the pending generation that will carry the answer to the
  // user's new utterance. Invalidating it was the cause of "the assistant goes
  // silent after an interruption".
  assert.equal(gate.isInvalidated('gen_2'), false);
  assert.equal(gate.acceptAudio('gen_2').accepted, true);
});

test('gate: barge-in during an actively streaming response invalidates that response', () => {
  const gate = new ConversationGate();
  gate.acceptAudio('gen_5');
  gate.markPlaybackScheduled('gen_5');

  const bargeIn = gate.localBargeIn();
  assert.deepEqual(bargeIn.invalidated, ['gen_5']);
  assert.equal(gate.acceptAudio('gen_5').accepted, false);
  assert.equal(gate.acceptAudio('gen_5').reason, 'invalidated');
  // The server will announce gen_6; it must be accepted.
  gate.noteNextGeneration('gen_6');
  assert.equal(gate.acceptAudio('gen_6').accepted, true);
});

test('gate: local barge-in with nothing playing is a no-op', () => {
  const gate = new ConversationGate();
  gate.acceptAudio('gen_1');
  gate.handleTurnComplete('gen_1', 'gen_2');
  gate.markPlaybackEnded('gen_1');
  assert.deepEqual(gate.localBargeIn().invalidated, []);
  assert.equal(gate.isInvalidated('gen_2'), false);
});

test('gate: server interruption invalidates only the reported generation and advances', () => {
  const gate = new ConversationGate();
  gate.acceptAudio('gen_1');
  gate.markPlaybackScheduled('gen_1');

  const first = gate.handleInterruption('gen_1', 'gen_2');
  assert.deepEqual(first.invalidated, ['gen_1']);
  assert.equal(first.firstObservation, true);
  assert.equal(first.nextGenerationId, 'gen_2');
  assert.equal(gate.acceptAudio('gen_1').accepted, false);

  // A duplicate event for the same generation must not double-count metrics.
  const duplicate = gate.handleInterruption('gen_1', 'gen_2');
  assert.deepEqual(duplicate.invalidated, []);
  assert.equal(duplicate.firstObservation, false);
  // Nor may it move the generation backwards.
  assert.equal(duplicate.nextGenerationId, 'gen_2');

  assert.equal(gate.acceptAudio('gen_2').accepted, true);
});

test('gate: repeated interruptions keep advancing monotonically', () => {
  const gate = new ConversationGate();
  gate.acceptAudio('gen_1');
  gate.handleInterruption('gen_1', 'gen_2');
  gate.acceptAudio('gen_2');
  gate.handleInterruption('gen_2', 'gen_3');
  gate.acceptAudio('gen_3');
  gate.handleInterruption('gen_3', 'gen_4');
  assert.equal(gate.getActiveGenerationId(), 'gen_4');
  assert.equal(gate.isInvalidated('gen_1'), true);
  assert.equal(gate.isInvalidated('gen_2'), true);
  assert.equal(gate.isInvalidated('gen_3'), true);
  assert.equal(gate.acceptAudio('gen_4').accepted, true);
});

test('gate: a local barge-in followed by the server interruption dedupes invalidation', () => {
  const gate = new ConversationGate();
  gate.acceptAudio('gen_7');
  gate.markPlaybackScheduled('gen_7');
  assert.deepEqual(gate.localBargeIn().invalidated, ['gen_7']);

  const serverEvent = gate.handleInterruption('gen_7', 'gen_8');
  assert.deepEqual(serverEvent.invalidated, []);
  assert.equal(serverEvent.firstObservation, false);
  assert.equal(gate.acceptAudio('gen_8').accepted, true);
});

test('gate: an untagged chunk cannot resurrect an invalidated generation', () => {
  const gate = new ConversationGate();
  gate.acceptAudio('gen_2');
  gate.markPlaybackScheduled('gen_2');
  gate.localBargeIn();
  const result = gate.acceptAudio(undefined);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'invalidated');
  assert.equal(result.generationId, 'gen_2');
});

test('gate: a generation stays "playing" until all of its chunks have ended', () => {
  const gate = new ConversationGate();
  gate.acceptAudio('gen_9');
  gate.markPlaybackScheduled('gen_9');
  gate.markPlaybackScheduled('gen_9');
  gate.markPlaybackScheduled('gen_9');
  assert.equal(gate.playbackCount(), 1);

  // One 32ms buffer ending must not make a multi-second response look silent.
  gate.markPlaybackEnded('gen_9');
  assert.equal(gate.isPlaying('gen_9'), true);
  assert.deepEqual(gate.localBargeIn().invalidated, ['gen_9']);

  // And once every chunk has ended there is nothing left to cancel.
  const gate2 = new ConversationGate();
  gate2.acceptAudio('gen_3');
  gate2.markPlaybackScheduled('gen_3');
  gate2.markPlaybackScheduled('gen_3');
  gate2.markPlaybackEnded('gen_3');
  assert.equal(gate2.isPlaying('gen_3'), true);
  gate2.markPlaybackEnded('gen_3');
  assert.equal(gate2.isPlaying('gen_3'), false);
  assert.equal(gate2.playbackCount(), 0);
});

test('gate: teardown also invalidates a pending active generation', () => {
  const gate = new ConversationGate();
  gate.acceptAudio('gen_1');
  gate.handleTurnComplete('gen_1', 'gen_2'); // gen_2 is pending, no audio yet
  gate.invalidateAll();
  assert.equal(gate.isInvalidated('gen_2'), true);
  assert.equal(gate.acceptAudio('gen_2').accepted, false);
});

test('cancellation: only invalidated generations are stopped, except on cleanup', () => {
  const scheduled = ['gen_1', 'gen_2'];

  // A late interruption for gen_1 must not truncate the already-scheduled
  // answer in gen_2.
  assert.deepEqual([...resolvePlaybackStopSet('server_interrupted', ['gen_1'], scheduled)], [
    'gen_1',
  ]);
  assert.deepEqual([...resolvePlaybackStopSet('local_onset', ['gen_1'], scheduled)], ['gen_1']);
  assert.deepEqual([...resolvePlaybackStopSet('session_cleanup', [], scheduled)], [
    'gen_1',
    'gen_2',
  ]);
});

test('barge-in: the tail of the interrupting utterance cannot cancel the answer', () => {
  const base = {
    isSpeaking: true,
    speechFrameCount: 3,
    playbackCount: 1,
    alreadyCancelled: false,
    suppressedUntilSilence: false,
  };
  assert.equal(shouldTriggerLocalBargeIn(base), true);
  // Same utterance, before any pause: suppressed.
  assert.equal(shouldTriggerLocalBargeIn({ ...base, suppressedUntilSilence: true }), false);
  // Already cancelled for this turn.
  assert.equal(shouldTriggerLocalBargeIn({ ...base, alreadyCancelled: true }), false);
  // Speech but no audio playing: nothing to cancel.
  assert.equal(shouldTriggerLocalBargeIn({ ...base, playbackCount: 0 }), false);
  // Onset debounce.
  assert.equal(shouldTriggerLocalBargeIn({ ...base, speechFrameCount: 2 }), false);
});

test('gate: reset isolates a new session from the previous invalidation set', () => {
  const gate = new ConversationGate();
  gate.acceptAudio('gen_1');
  gate.handleInterruption('gen_1', 'gen_2');
  gate.reset();
  assert.equal(gate.getActiveGenerationId(), 'gen_0');
  assert.equal(gate.isInvalidated('gen_1'), false);
  // A new session restarts numbering at gen_1 server-side.
  assert.equal(gate.acceptAudio('gen_1').accepted, true);
});

test('gate: teardown blocks every late chunk', () => {
  const gate = new ConversationGate();
  gate.acceptAudio('gen_2');
  gate.markPlaybackScheduled('gen_2');
  gate.invalidateAll();
  assert.equal(gate.acceptAudio('gen_2').accepted, false);
  assert.equal(gate.playbackCount(), 0);
});

test('ledger: chunks of the same generation accumulate into one turn', () => {
  const ledger = new TurnLedger(() => '2026-01-01T00:00:00.000Z');
  const first = ledger.addAudio('gen_1', 32);
  assert.equal(first.created, true);
  ledger.addAudio('gen_1', 32);
  const turns = ledger.snapshot();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].audioChunksCount, 2);
  assert.equal(turns[0].totalAudioDurationMs, 64);
});

test('ledger: a late turn_complete closes the turn it names, not the newest turn', () => {
  const ledger = new TurnLedger();
  ledger.addAudio('gen_1', 100);
  ledger.addAudio('gen_2', 100); // newer turn already started
  assert.equal(ledger.complete('gen_1'), true);
  assert.equal(ledger.get('gen_1')?.status, 'completed');
  assert.equal(ledger.get('gen_2')?.status, 'responding');

  // A second completion for gen_1 must not change anything.
  assert.equal(ledger.complete('gen_1'), false);
});

test('ledger: interruption marks only the interrupted generation', () => {
  const ledger = new TurnLedger();
  ledger.addAudio('gen_1', 100);
  assert.equal(ledger.interrupt('gen_1'), true);
  assert.equal(ledger.get('gen_1')?.status, 'interrupted');
  assert.equal(ledger.complete('gen_1'), false);
});

test('ledger: audio after completion cannot mutate the closed turn', () => {
  const ledger = new TurnLedger();
  ledger.addAudio('gen_1', 100);
  ledger.complete('gen_1');
  const late = ledger.addAudio('gen_1', 100);
  assert.equal(late.created, true);
  assert.equal(late.turn.status, 'responding');
  assert.equal(late.turn.audioChunksCount, 1);
  assert.equal(ledger.size(), 2);
});

test('ledger: transcript before audio creates the turn and is preserved', () => {
  const ledger = new TurnLedger();
  const turn = ledger.appendText('gen_4', 'Hello');
  assert.ok(turn);
  assert.equal(turn?.audioChunksCount, 0);
  ledger.appendText('gen_4', ' there');
  ledger.addAudio('gen_4', 200);
  const stored = ledger.get('gen_4');
  assert.equal(stored?.text, 'Hello there');
  assert.equal(stored?.audioChunksCount, 1);
  assert.equal(ledger.size(), 1);
});

test('ledger: clear isolates sessions', () => {
  const ledger = new TurnLedger();
  ledger.addAudio('gen_1', 10);
  ledger.clear();
  assert.equal(ledger.size(), 0);
  assert.equal(ledger.get('gen_1'), null);
});

test('customer transcript ledger: tracks interim and appends deduplicated final utterances', () => {
  const ledger = new CustomerTranscriptLedger(5);
  ledger.setInterim('I am looking for');
  assert.equal(ledger.getInterim(), 'I am looking for');

  // Add finalized utterance
  const first = ledger.addFinal('I am looking for pricing information.');
  assert.equal(first.added, true);
  assert.equal(ledger.getInterim(), null);
  assert.equal(ledger.getEntries().length, 1);
  assert.equal(ledger.getEntries()[0].text, 'I am looking for pricing information.');

  // Immediate identical duplicate is ignored
  const dup = ledger.addFinal('I am looking for pricing information.');
  assert.equal(dup.added, false);
  assert.equal(ledger.getEntries().length, 1);

  // New distinct utterance is appended
  const second = ledger.addFinal('Do you have enterprise discounts?');
  assert.equal(second.added, true);
  assert.equal(ledger.getEntries().length, 2);
});

test('customer transcript ledger: respects max entries bounding and clears cleanly', () => {
  const ledger = new CustomerTranscriptLedger(3);
  ledger.addFinal('Utterance 1');
  ledger.addFinal('Utterance 2');
  ledger.addFinal('Utterance 3');
  ledger.addFinal('Utterance 4');

  const entries = ledger.getEntries();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].text, 'Utterance 2');
  assert.equal(entries[2].text, 'Utterance 4');

  ledger.clear();
  assert.equal(ledger.getEntries().length, 0);
  assert.equal(ledger.getInterim(), null);
});

test('sales suggestion ledger: accumulates streaming deltas per generation and completes turn', () => {
  const ledger = new SalesSuggestionLedger(10);
  const chunk1 = ledger.appendDelta('gen_1', 'Ask if they are considering');
  assert.equal(chunk1.created, true);
  assert.equal(ledger.getLatest()?.status, 'streaming');
  assert.equal(ledger.getLatest()?.text, 'Ask if they are considering');

  const chunk2 = ledger.appendDelta('gen_1', ' annual billing for a discount.');
  assert.equal(chunk2.created, false);
  assert.equal(ledger.getLatest()?.text, 'Ask if they are considering annual billing for a discount.');

  // Complete turn
  const comp = ledger.completeTurn('gen_1');
  assert.ok(comp);
  assert.equal(comp?.status, 'completed');
  assert.equal(ledger.getLatest()?.status, 'completed');
  assert.equal(ledger.get('gen_1')?.status, 'completed');
});

test('sales suggestion ledger: handles mid-turn customer interruption cleanly', () => {
  const ledger = new SalesSuggestionLedger(10);
  ledger.appendDelta('gen_1', 'Start offering standard 10% discount');
  assert.equal(ledger.getLatest()?.status, 'streaming');

  // Customer interrupts mid-generation
  const intr = ledger.interruptTurn('gen_1', 'gen_2');
  assert.ok(intr);
  assert.equal(intr?.status, 'interrupted');
  assert.equal(ledger.get('gen_1')?.status, 'interrupted');

  // Late delta for an already-interrupted generation does not revert status to streaming
  ledger.appendDelta('gen_1', ' and free onboarding');
  assert.equal(ledger.get('gen_1')?.status, 'interrupted');

  // Next generation starts cleanly
  ledger.appendDelta('gen_2', 'Acknowledge custom SLA requirement.');
  assert.equal(ledger.getLatest()?.generationId, 'gen_2');
  assert.equal(ledger.getLatest()?.status, 'streaming');
  assert.equal(ledger.getAll().length, 2);
});

test('sales suggestion ledger: bounds entries to maxEntries and clears cleanly', () => {
  const ledger = new SalesSuggestionLedger(2);
  ledger.appendDelta('gen_1', 'Suggestion 1');
  ledger.appendDelta('gen_2', 'Suggestion 2');
  ledger.appendDelta('gen_3', 'Suggestion 3');

  const all = ledger.getAll();
  assert.equal(all.length, 2);
  assert.equal(all[0].generationId, 'gen_3');
  assert.equal(all[1].generationId, 'gen_2');

  ledger.clear();
  assert.equal(ledger.getAll().length, 0);
  assert.equal(ledger.getLatest(), null);
});



/* ------------------------------------------------------------------------- */
/* Stage 4: interruption lifecycle (production mapping)                       */
/* ------------------------------------------------------------------------- */

/**
 * Minimal in-test driver for the bridge's generation state machine. It applies
 * the *production* decision functions (`resolveInterruptionAttribution` and
 * `resolveTurnCompletion`) exactly as `server.ts` does, so the sequences below
 * are the same ones a live session produces.
 */
class BridgeLifecycle {
  currentGenerationId = 'gen_0';
  lastContentGenerationId: string | null = null;
  interruptedGenerationId: string | null = null;
  readonly interrupted = new Set<string>();
  readonly closed = new Set<string>();
  private counter = 0;

  private nextGeneration(): void {
    this.counter += 1;
    this.currentGenerationId = `gen_${this.counter}`;
  }

  content(): string {
    if (this.currentGenerationId === 'gen_0') this.nextGeneration();
    this.lastContentGenerationId = this.currentGenerationId;
    return this.currentGenerationId;
  }

  interrupt(): { generationId: string; duplicate: boolean; advance: boolean } {
    const attribution = resolveInterruptionAttribution({
      currentGenerationId: this.currentGenerationId,
      lastContentGenerationId: this.lastContentGenerationId,
      alreadyInterrupted: [...this.interrupted],
    });
    if (!attribution.duplicate) {
      this.interrupted.add(attribution.interruptedGenerationId);
      this.interruptedGenerationId = attribution.interruptedGenerationId;
    }
    if (attribution.advanceGeneration) this.nextGeneration();
    return {
      generationId: attribution.interruptedGenerationId,
      duplicate: attribution.duplicate,
      advance: attribution.advanceGeneration,
    };
  }

  complete(): ReturnType<typeof resolveTurnCompletion> {
    const completion = resolveTurnCompletion({
      currentGenerationId: this.currentGenerationId,
      currentHasContent: this.lastContentGenerationId === this.currentGenerationId,
      interruptedGenerationId: this.interruptedGenerationId,
      lastContentGenerationId: this.lastContentGenerationId,
      alreadyClosedGenerationIds: [...this.closed],
    });
    if (completion.advanceGeneration) this.nextGeneration();
    if (completion.advanceGeneration || completion.closesInterruptedTurn) {
      this.closed.add(completion.completedGenerationId);
    }
    this.interruptedGenerationId = null;
    return completion;
  }
}

test('lifecycle: normal uninterrupted completion advances exactly once', () => {
  const bridge = new BridgeLifecycle();
  const gen = bridge.content();
  assert.equal(gen, 'gen_1');

  const completion = bridge.complete();
  assert.equal(completion.completedGenerationId, 'gen_1');
  assert.equal(completion.closesInterruptedTurn, false);
  assert.equal(completion.advanceGeneration, true);
  assert.equal(completion.duplicate, false);
  assert.equal(bridge.currentGenerationId, 'gen_2');
});

test('lifecycle: a duplicate completion event cannot advance a generation twice', () => {
  const bridge = new BridgeLifecycle();
  bridge.content();
  bridge.complete();
  assert.equal(bridge.currentGenerationId, 'gen_2');

  const duplicate = bridge.complete();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.advanceGeneration, false);
  assert.equal(duplicate.completedGenerationId, 'gen_1');
  assert.equal(bridge.currentGenerationId, 'gen_2');
});

test('lifecycle: interruption followed by completion closes the interrupted generation once', () => {
  const bridge = new BridgeLifecycle();
  const gen = bridge.content();

  const interruption = bridge.interrupt();
  assert.equal(interruption.generationId, gen);
  assert.equal(interruption.duplicate, false);
  assert.equal(bridge.currentGenerationId, 'gen_2');

  const completion = bridge.complete();
  assert.equal(completion.completedGenerationId, gen);
  assert.equal(completion.closesInterruptedTurn, true);
  assert.equal(completion.advanceGeneration, false);
  // One barge-in must consume exactly one generation ID.
  assert.equal(bridge.currentGenerationId, 'gen_2');

  // The answer to the barge-in reuses the reserved slot.
  assert.equal(bridge.content(), 'gen_2');
});

test('lifecycle: repeated interruption events are idempotent', () => {
  const bridge = new BridgeLifecycle();
  bridge.content();
  assert.equal(bridge.interrupt().generationId, 'gen_1');
  assert.equal(bridge.currentGenerationId, 'gen_2');

  const duplicate = bridge.interrupt();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.advance, false);
  assert.equal(duplicate.generationId, 'gen_1');
  assert.equal(bridge.currentGenerationId, 'gen_2');
});

test('lifecycle: interruption after turn_complete is attributed to the generation that produced content', () => {
  const bridge = new BridgeLifecycle();
  bridge.content(); // gen_1 produced content
  bridge.complete(); // reserve gen_2 while gen_1 may still be audible
  assert.equal(bridge.currentGenerationId, 'gen_2');

  // The barge-in must retire gen_1 (the audible response), not the empty slot.
  const interruption = bridge.interrupt();
  assert.equal(interruption.generationId, 'gen_1');
  assert.equal(interruption.advance, false);
  assert.equal(bridge.currentGenerationId, 'gen_2');
});


test('lifecycle: a late output transcript cannot be attributed to the newest generation', () => {
  const bridge = new BridgeLifecycle();
  bridge.content(); // gen_1 streaming
  bridge.interrupt();
  bridge.complete(); // gen_1 interrupted and closed
  const answerGen = bridge.content(); // gen_2
  assert.equal(answerGen, 'gen_2');

  // A delayed transcript tagged with the terminal generation is stale, and an
  // untagged one is unattributed - neither may become a gen_2 suggestion.
  const ledger = new SalesSuggestionLedger(10);
  ledger.appendDelta(answerGen, 'Active suggestion');
  const late = ledger.appendDelta('gen_1', 'obsolescent tail');
  assert.equal(late.isStale, true);
  const untagged = ledger.appendDelta(undefined, 'obsolescent tail');
  assert.equal(untagged.unattributed, true);
  assert.equal(untagged.entry, null);

  assert.equal(ledger.getAll().length, 1);
  assert.equal(ledger.getLatest()?.generationId, 'gen_2');
  assert.equal(ledger.get('gen_1'), null);
});

test('lifecycle: an interrupted generation can never become completed', () => {
  const suggestions = new SalesSuggestionLedger(10);
  suggestions.appendDelta('gen_1', 'Offer the annual plan');
  assert.ok(suggestions.interruptTurn('gen_1', 'gen_2'));
  // The trailing turn_complete names gen_1; completing it must be a no-op.
  assert.equal(suggestions.completeTurn('gen_1'), null);
  assert.equal(suggestions.get('gen_1')?.status, 'interrupted');

  const turns = new TurnLedger();
  turns.appendText('gen_1', 'Offer the annual plan');
  assert.equal(turns.interrupt('gen_1'), true);
  assert.equal(turns.complete('gen_1'), false);
  assert.equal(turns.get('gen_1')?.status, 'interrupted');
});

test('lifecycle: invalid lifecycle transitions are rejected without mutating the record', () => {
  const suggestions = new SalesSuggestionLedger(10);
  suggestions.appendDelta('gen_1', 'Offer the annual plan');
  assert.ok(suggestions.completeTurn('gen_1'));
  assert.equal(suggestions.interruptTurn('gen_1', 'gen_2'), null);
  assert.equal(suggestions.get('gen_1')?.status, 'completed');
  // Late text cannot reopen a completed generation.
  const late = suggestions.appendDelta('gen_1', ' ...and onboarding');
  assert.equal(late.isStale, true);
  assert.equal(suggestions.get('gen_1')?.text, 'Offer the annual plan');

  const turns = new TurnLedger();
  turns.appendText('gen_1', 'Offer the annual plan');
  assert.equal(turns.complete('gen_1'), true);
  assert.equal(turns.interrupt('gen_1'), false);
  assert.equal(turns.get('gen_1')?.status, 'completed');
});

test('lifecycle: a new customer utterance retires an obsolete streaming suggestion', () => {
  const ledger = new SalesSuggestionLedger(10);
  ledger.appendDelta('gen_1', 'Obsolete recommendation');
  ledger.appendDelta('gen_2', 'Current recommendation');
  assert.equal(ledger.get('gen_1')?.status, 'streaming');

  const retired = ledger.retireStreamingBefore('gen_2');
  assert.deepEqual(
    retired.map((entry) => entry.generationId),
    ['gen_1']
  );
  assert.equal(ledger.get('gen_1')?.status, 'interrupted');
  // The recommendation that belongs to the current generation is untouched.
  assert.equal(ledger.get('gen_2')?.status, 'streaming');
  assert.equal(ledger.getLatest()?.generationId, 'gen_2');

  // Missing attribution cannot demote anything.
  assert.deepEqual(ledger.retireStreamingBefore(null), []);
});


test('lifecycle: empty/audio-only parts cannot create an empty suggestion record', () => {
  const ledger = new SalesSuggestionLedger(10);
  assert.equal(ledger.appendDelta('gen_1', '').created, false);
  assert.equal(ledger.appendDelta('gen_1', '   ').created, false);
  assert.equal(ledger.appendDelta('gen_1', '\n').created, false);
  assert.equal(ledger.size(), 0);
  assert.equal(ledger.getLatest(), null);

  // Whitespace appended to a real suggestion is still preserved verbatim.
  ledger.appendDelta('gen_1', 'Ask about');
  const spaced = ledger.appendDelta('gen_1', ' budget ');
  assert.equal(spaced.created, false);
  assert.equal(ledger.get('gen_1')?.text, 'Ask about budget ');
});

test('lifecycle: a terminal generation cannot be resurrected after eviction', () => {
  const ledger = new SalesSuggestionLedger(2);
  ledger.appendDelta('gen_1', 'First');
  ledger.appendDelta('gen_2', 'Second');
  ledger.appendDelta('gen_3', 'Third'); // evicts gen_1

  assert.equal(ledger.size(), 2);
  const late = ledger.appendDelta('gen_1', ' late tail');
  assert.equal(late.isStale, true);
  assert.equal(late.created, false);
  assert.equal(ledger.size(), 2);
  assert.equal(ledger.getLatest()?.generationId, 'gen_3');
  // No duplicate historical record was created.
  assert.equal(
    ledger.getAll().filter((entry) => entry.generationId === 'gen_1').length,
    0
  );
});

test('lifecycle: a late delta for an older live record never becomes the latest', () => {
  const ledger = new SalesSuggestionLedger(10);
  ledger.appendDelta('gen_1', 'First suggestion');
  ledger.appendDelta('gen_2', 'Second suggestion');

  // gen_1 is older than the active generation: late text is stale, not merged.
  const late = ledger.appendDelta('gen_1', ' extra');
  assert.equal(late.isStale, true);
  assert.equal(ledger.getLatest()?.generationId, 'gen_2');
  assert.equal(ledger.get('gen_1')?.text, 'First suggestion');
  assert.deepEqual(
    ledger.getAll().map((entry) => entry.generationId),
    ['gen_2', 'gen_1']
  );
});

test('lifecycle: missing generation ids are never completed or interrupted', () => {
  const ledger = new SalesSuggestionLedger(10);
  ledger.appendDelta('gen_1', 'Suggestion');
  assert.equal(ledger.completeTurn(undefined), null);
  assert.equal(ledger.completeTurn(null), null);
  assert.equal(ledger.interruptTurn(undefined, undefined), null);
  assert.equal(ledger.interruptTurn(null, null), null);
  assert.equal(ledger.get('gen_1')?.status, 'streaming');
  assert.deepEqual(ledger.retireStreamingBefore(undefined), []);
});

test('lifecycle: events from a superseded transport epoch are rejected', () => {
  assert.equal(isStaleTransportEpoch(3, 2), true);
  assert.equal(isStaleTransportEpoch(3, 4), true);
  assert.equal(isStaleTransportEpoch(3, 3), false);
});

test('gate: an interruption attributed to a reserved slot still stops the older playing tail', () => {
  const gate = new ConversationGate();
  gate.acceptAudio('gen_1');
  gate.markPlaybackScheduled('gen_1');
  gate.handleTurnComplete('gen_1', 'gen_2'); // gen_2 reserved, no content

  const interruption = gate.handleInterruption('gen_1', 'gen_2');
  assert.deepEqual(interruption.invalidated, ['gen_1']);
  assert.equal(gate.isInvalidated('gen_1'), true);
  assert.equal(gate.isInvalidated('gen_2'), false);
  assert.equal(gate.acceptAudio('gen_2').accepted, true);
});

