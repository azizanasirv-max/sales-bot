import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConversationGate,
  TurnLedger,
  buildLanguageInstruction,
  composeSystemInstruction,
  resolveLanguagePreference,
  resolvePlaybackStopSet,
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


