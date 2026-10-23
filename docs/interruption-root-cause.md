# Gemini Live interruption handling — audit and root-cause report

Scope: the existing React client (`src/App.tsx`), the Node bridge (`server.ts`) and
the shared gate/ledger (`src/lib/conversation.ts`). No model, voice, resumption or
language-policy behaviour was changed.

## 1. Audio lifecycle as implemented

| Stage | Location | Behaviour |
| --- | --- | --- |
| Microphone capture | `App.tsx` `startConversation` → `ScriptProcessorNode(512)` | 512 frames per callback (~32 ms at 16 kHz, ~10.7 ms if the browser rejects the forced 16 kHz context). `echoCancellation`, `noiseSuppression` and `autoGainControl` are all enabled. |
| Resampling / encoding | `src/utils/audio.ts` | `resampleTo16k` (no-op when the context really is 16 kHz), 16-bit LE PCM, base64. |
| Streaming during playback | `processor.onaudioprocess` | **Always sends.** Nothing gates the microphone on `receiving_audio`/playback state. Full duplex is preserved. |
| Local VAD | `App.tsx` `onaudioprocess` + `shouldTriggerLocalBargeIn` | `rms > 0.025`, three consecutive voiced frames (~96 ms) to trigger, then `suppressBargeInUntilSilence` requires one silent frame before another local cancellation. |
| Playback queue | `activeSourcesRef`, `nextPlayTimeRef`, per-generation `GainNode` | Chunks are scheduled back-to-back with a 5 ms lead. There is **no look-ahead cap**, so the queue can run ahead of real time by the length of the remaining response. |
| Cancellation | `cancelAllAssistantAudio` | Stops only the invalidated generations' `AudioBufferSourceNode`s, mutes/detaches their gain nodes, and moves `nextPlayTimeRef` past kept sources. |
| Server generation | `server.ts` `nextGeneration` / `handleServerMessage` | IDs `gen_N` were advanced on data, `interrupted` **and** `turnComplete`. |
| Client generation | `ConversationGate` | Accepts audio only for non-invalidated, non-stale generations; `turn_complete`/`interrupted` advance the active ID. |
| Server interruption | `serverContent.interrupted` | "a client message has interrupted current model generation … this is a good signal to stop and empty the current playback queue." The API then sends `interrupted > turn_complete` for that generation. |

## 2. Root causes (ranked by confidence)

### RC-1 (confirmed) — an interruption is attributed to an empty generation after `turn_complete`

`server.ts` advanced `currentGenerationId` when the model reported `turnComplete`,
even though the browser may still be playing the response from a large scheduling
look-ahead. A barge-in during that tail arrives while `currentGenerationId` is the
empty "next" slot, so the bridge sent `interruptedGenerationId = <empty slot>`.
The client invalidated that empty slot and stopped nothing; the audible
generation kept playing. This is a direct, code-level cause of "Gemini continues
speaking after the customer interrupts" whenever local VAD does not also fire.

Demonstrated with the original gate (see §4, reproduction 1): the old code
returns `invalidated: ['gen_2']`, `gen_1` still playing.

Fix: the bridge records the last generation that delivered content and attributes
the interruption to it (`resolveInterruptionAttribution`). The client gate also
invalidates any *older* generation that is still scheduled, as a belt-and-braces
guard (`ConversationGate.handleInterruption`).

### RC-2 (confirmed) — one barge-in consumed two generations, and the trailing `turn_complete` was misattributed

The API documents that an interrupted turn has no `generationComplete`; it goes
`interrupted > turn_complete`. The bridge advanced on `interrupted` and again on
that closing `turnComplete`, so:

* the closing completion named a generation that never produced content;
* the client logged it as "Turn completed cleanly by Gemini Live API" and
  incremented `completedTurns` for an interrupted turn;
* the generation numbering skipped, which makes interruption diagnostics
  ambiguous.

Demonstrated (reproduction 2): old sequence
`gen_1 audio → turn_complete(gen_1) → interrupted(gen_2) → turn_complete(gen_3)` — three IDs
for one turn. New sequence:
`gen_1 audio → turn_complete(gen_1) → interrupted(gen_1, next gen_2, no advance) → turn_complete(gen_1, closesInterruptedTurn)`.

Fix: `resolveTurnCompletion` closes the interrupted generation without advancing;
duplicates no longer consume a generation either.


### RC-3 (confirmed by code, live-unverified) — content that arrives with the interruption flag was re-tagged as the next response

`handleServerMessage` handled `interrupted` first and then forwarded `modelTurn`
parts of the same message under the freshly reserved generation. The protocol
cannot contain the answer to the interrupting utterance in that frame (the API
emits `interrupted > turnComplete` before producing the next turn), so those
parts are the interrupted turn's tail. Forwarding them as the new generation
made the client accept and **schedule stale audio after the interruption**.

Fix: content parts in a frame carrying `interrupted` are dropped and counted
(`modelPartsDroppedAfterInterrupt`, visible in logs/diagnostics). Regression
coverage: code-path inspection; needs live confirmation that no legitimate first
chunk is ever coalesced with the flag (see §5).

### RC-4 (confirmed) — duplicate interruption events corrupted generation and timing state

Previously every `interrupted` frame advanced the bridge counter and reset the
client's `lastInterruptionMono`/UI state, even when it was a repeat for the same
generation. A duplicate therefore consumed an extra ID and made
"interruption → next audio" look instantaneous.

Fix: attribution is idempotent (`alreadyInterrupted` membership), the frame
carries `duplicate: true`, and the client ignores duplicates for timing, state
and turn accounting while still keeping the gate in sync. Covered by unit tests.

### RC-5 (confirmed, diagnostics only) — two latency/accounting metrics were misleading

* `interruptionToStopDurationMs` measures cancellation *work*, not the time from
  the customer's speech to silence.
* `uniqueGenerationsInterrupted` used the gate's `firstObservation`, which is
  `false` for the first *server* event when a local barge-in already invalidated
  the generation — undercounting confirmed interruptions.

Fix: new `localOnsetToPlaybackSilenceMs`, `serverInterruptionToPlaybackSilenceMs`,
`bridgeToBrowserInterruptionDelayMs`, `staleAudioChunksDropped`,
`duplicateInterruptionEvents`; `uniqueGenerationsInterrupted` now uses the
bridge's authoritative counter. `interruptionToNextResponseAudibleMs` is
unchanged and remains measured separately from silence.

### RC-6 (suspected, requires live testing) — browser AEC can attenuate the interrupting voice

`getUserMedia` enables `echoCancellation`, `noiseSuppression` and
`autoGainControl`. Browser AEC suppresses near-end speech during double-talk
(exactly when the user interrupts). The transport itself is continuous in code,
so "Gemini did not understand the interruption" can be caused by degraded
microphone content rather than model detection. Not changed: this is a live
A/B question (headphones vs speakers, AEC on/off), and changing constraints
blindly would alter the capture architecture.

### RC-7 (suspected, requires live testing) — response latency floor after an interruption is Gemini's end-of-speech detection

`buildLiveConfig` does not set `realtimeInputConfig.automaticActivityDetection`.
The default `silenceDurationMs`/`endOfSpeechSensitivity` therefore controls when
the model decides the interrupting utterance is over and starts answering. The
client adds no delay (the playback cursor is reset to "now" on cancellation).
Tuning these fields would change model configuration, so it is deliberately left
alone until live measurements separate server detection from app latency.

### Non-findings

* Microphone chunks are not gated on AI playback; the bridge forwards them
  whenever the Gemini transport is open (`micChunksForwarded` on the
  `interrupted` frame proves flow at detection time).
* Local playback cancellation and server-side cancellation are separate: the app
  never sends a cancel to Gemini (the Live API has no such call); Gemini's own
  VAD performs the server-side cut. The client only stops its own queue.
* No second STT/TTS path exists.
* Audio from an invalidated generation cannot be scheduled (`acceptAudio`
  precedes decode/schedule); stale chunks are counted and dropped, never played.
* `suppressBargeInUntilSilence` intentionally prevents the tail of one utterance
  from cancelling the answer to that same utterance; it is not the cause of a
  missed interruption, but it does mean a second utterance without a silent
  frame cannot cancel the new answer.

## 3. Files changed

| File | Change |
| --- | --- |
| `src/lib/conversation.ts` | Added `resolveInterruptionAttribution` / `resolveTurnCompletion` (server generation attribution); `ConversationGate.handleInterruption` now also invalidates older generations that are still playing. |
| `server.ts` | Tracks `lastContentGenerationId` / `interruptedGenerationId`; attributes interruptions to the generation that produced content; advances at most once per interrupted turn; drops content received with the interruption flag; duplicate events do not advance; diagnostic counters (`micChunks*`, `msSinceLastMicForward`, `bridgeInterruptedSentUtc`, `modelPartsDroppedAfterInterrupt`). |
| `src/App.tsx` | Ignores duplicate interruption frames for timing/state; authoritative unique-interruption count; stale-chunk counter; local VAD onset event; onset→silence and server→silence metrics; approximate bridge→browser delivery delay; UI shows onset→silence and bridge→browser delay. |
| `tests/unit/conversation.test.ts` | Regression tests for the tail barge-in, newer-generation preservation, attribution, turn completion, duplicate idempotency and the documented `interrupted > turn_complete` sequence. |
| `docs/interruption-root-cause.md` | This report. |

## 4. Reproduction and offline verification

Environment: no `GEMINI_API_KEY` (and no `.env`), so live tests were **not**
executed.

Baseline before changes:

```
npm test     → 50 tests, 50 pass
npm run lint → tsc --noEmit clean
npm run build→ vite build OK
```

After changes:

```
npm test      → 59 tests, 59 pass (unit + bridge protocol)
npm run lint  → clean
npm run build → dist built (vite 8.3.5)
```

Reproduction 1 (gate, tail interruption) — run against the original
`src/lib/conversation.ts` from `main`:

```
OLD gate tail interruption: { invalidated: [ 'gen_2' ], gen1Invalidated: false, stillPlaying: 1 }
NEW gate tail interruption: { invalidated: [ 'gen_2', 'gen_1' ], gen1Invalidated: true, stillPlaying: 0 }
```

Reproduction 2 (bridge sequence, documented API order):

```
OLD: audio gen_1 → turn_complete(gen_1) → interrupted(gen_2) → turn_complete(gen_3)
NEW: audio gen_1 → turn_complete(gen_1) → interrupted(gen_1) → turn_complete(gen_1, closesInterruptedTurn)
```

## 5. Remaining live-test requirements

1. Run `npm run dev` with a key, then `npm run test:live` and
   `npm run test:live-trials` (prompt/interrupt WAV fixtures).
2. Interrupt at the beginning, middle and end of playback, plus repeated
   interruptions in one turn. For each trial record:
   * `localOnsetToPlaybackSilenceMs` (should be roughly the ~96 ms VAD debounce
     plus <5 ms cancellation work);
   * `serverInterruptionToPlaybackSilenceMs`;
   * `interruptionToNextResponseAudibleMs`;
   * `staleAudioChunksDropped` (should increase only for in-flight chunks of the
     interrupted generation) and `modelPartsDroppedAfterInterrupt`;
   * `duplicateInterruptionEvents` (should be ignored, not advance generations).
3. Check the browser console/event stream for `Turn completed cleanly` on an
   interrupted turn — with RC-2 fixed this must not happen; the closing event
   should say `Turn closed after interruption`.
4. Verify RC-3 in a live trace: if `modelPartsDroppedAfterInterrupt` is non-zero
   and the next response is nevertheless complete, the coalescing assumption is
   confirmed. If a live trace ever shows a missing first syllable, the same-frame
   drop should be revisited.
5. A/B the microphone path with headphones and with AEC/NS/AGC disabled to
   quantify RC-6; use the user transcript diagnostics to see whether the
   interrupting words reached Gemini at all.
6. Compare default automatic VAD against an explicit
   `realtimeInputConfig.automaticActivityDetection` (e.g. `endOfSpeechSensitivity:
   HIGH`, `silenceDurationMs` 300–500) to quantify RC-7 before changing the
   model configuration.

## 6. Measured latency

No live Gemini session was available, so interruption-to-silence and
interruption-to-next-audio numbers could not be produced. The offline
measurements are limited to the cancellation work and are not representative of
acoustic playback. The added fields in §RC-5 are what the live trials must
record; they are intentionally separated:

* interruption (local onset or server frame) → playback silent;
* interruption → first chunk of the next response scheduled/audible;
* bridge → browser delivery delay (wall clock, approximate).

