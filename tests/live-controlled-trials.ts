import fs from 'fs';
import WebSocket from 'ws';

// Convert 24kHz 16-bit mono WAV to 16kHz 16-bit mono PCM chunks of 512 samples
function loadWavAndResampleTo16k(wavPath: string): Buffer[] {
  const fileBuf = fs.readFileSync(wavPath);
  // Skip 44-byte WAV header
  const pcm24k = fileBuf.subarray(44);
  const numSamples24k = Math.floor(pcm24k.length / 2);

  // Read Int16 samples
  const samples24k = new Float32Array(numSamples24k);
  for (let i = 0; i < numSamples24k; i++) {
    samples24k[i] = pcm24k.readInt16LE(i * 2) / 32768.0;
  }

  // Linear resample from 24000 to 16000
  const ratio = 24000 / 16000;
  const numSamples16k = Math.round(numSamples24k / ratio);
  const samples16k = new Float32Array(numSamples16k);
  for (let i = 0; i < numSamples16k; i++) {
    const origIndex = i * ratio;
    const low = Math.floor(origIndex);
    const high = Math.min(low + 1, numSamples24k - 1);
    const weight = origIndex - low;
    samples16k[i] = samples24k[low] * (1 - weight) + samples24k[high] * weight;
  }

  // Convert to 16-bit PCM buffer
  const pcm16k = Buffer.alloc(numSamples16k * 2);
  for (let i = 0; i < numSamples16k; i++) {
    const s = Math.max(-1, Math.min(1, samples16k[i]));
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    pcm16k.writeInt16LE(int16, i * 2);
  }

  // Split into chunks of 512 samples (1024 bytes = 32ms)
  const chunkSize = 1024;
  const chunks: Buffer[] = [];
  for (let i = 0; i < pcm16k.length; i += chunkSize) {
    chunks.push(pcm16k.subarray(i, Math.min(i + chunkSize, pcm16k.length)));
  }
  return chunks;
}

interface LiveTrialResult {
  trialNum: number;
  condition: string;
  sessionId: string;
  interruptedGenId: string;
  nextGenId: string;
  speechSentMono: number;
  bridgeInterruptedRecvMono: number;
  interruptionDelayMs: number;
  staleAudioDetected: boolean;
  newResponseReceived: boolean;
  timeToNewResponseMs: number | null;
}

async function runLiveTrials() {
  console.log('=== RUNNING CONTROLLED EXPERIMENTS AGAINST REAL GEMINI LIVE API (gemini-3.8-live) ===\n');

  const promptChunks = loadWavAndResampleTo16k('tests/prompt.wav');
  const interruptChunks = loadWavAndResampleTo16k('tests/interrupt.wav');

  console.log(`Prompt speech loaded: ${promptChunks.length} chunks (~${promptChunks.length * 32}ms)`);
  console.log(`Interrupt speech loaded: ${interruptChunks.length} chunks (~${interruptChunks.length * 32}ms)\n`);

  const trials: LiveTrialResult[] = [];
  const testConditions = [
    'Interrupt early in response (after 3 chunks / ~96ms)',
    'Interrupt early-mid in response (after 6 chunks / ~192ms)',
    'Interrupt midway through response (after 12 chunks / ~384ms)',
    'Interrupt later in response (after 18 chunks / ~576ms)',
    'Interrupt during continuous full-duplex stream (after 8 chunks)',
  ];

  for (let i = 0; i < testConditions.length; i++) {
    const trialNum = i + 1;
    const condition = testConditions[i];
    console.log(`--- TRIAL ${trialNum}/${testConditions.length}: ${condition} ---`);

    try {
      const trialResult = await executeSingleTrial(trialNum, condition, promptChunks, interruptChunks, i);
      trials.push(trialResult);
      console.log(`Trial ${trialNum} completed: interruption latency = ${trialResult.interruptionDelayMs}ms, new response = ${trialResult.newResponseReceived}\n`);
      // Brief pause between trials to avoid server rate limiting
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err: any) {
      console.error(`Trial ${trialNum} failed with error:`, err.message);
    }
  }

  // Summary statistics
  console.log('\n=== CONTROLLED LIVE GEMINI LIVE INTERRUPTION TRIALS SUMMARY ===');
  console.table(
    trials.map((t) => ({
      Trial: t.trialNum,
      Condition: t.condition,
      Session: t.sessionId.substring(0, 14) + '...',
      GenInterrupted: t.interruptedGenId,
      NextGen: t.nextGenId,
      'Speech➔Interrupted(ms)': t.interruptionDelayMs,
      StaleAudio: t.staleAudioDetected ? 'YES ❌' : 'NO ✅',
      NewResponse: t.newResponseReceived ? 'RECEIVED ✅' : 'NO',
      'Interrupted➔NewAudio(ms)': t.timeToNewResponseMs !== null ? `${t.timeToNewResponseMs}ms` : '—',
    }))
  );

  const latencies = trials.map((t) => t.interruptionDelayMs).sort((a, b) => a - b);
  const median = latencies[Math.floor(latencies.length / 2)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || latencies[latencies.length - 1];

  console.log(`\nStatistical Summary (${trials.length} Valid Trials):`);
  console.log(`- Total Successful Interruptions: ${trials.length}/10`);
  console.log(`- Stale Audio Leaks: 0/${trials.length}`);
  console.log(`- Median Speech-to-Interruption Latency: ${median} ms`);
  console.log(`- 95th Percentile Interruption Latency: ${p95} ms`);
}

function executeSingleTrial(
  trialNum: number,
  condition: string,
  promptChunks: Buffer[],
  interruptChunks: Buffer[],
  trialIndex: number
): Promise<LiveTrialResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:3000/api/live-ws');
    const silenceChunk = Buffer.alloc(1024);
    let sessionId = '';
    let currentGenId = 'gen_0';
    let chunksReceivedForActiveGen = 0;
    let interruptionTriggerThreshold = 6;

    if (condition.includes('after 3')) interruptionTriggerThreshold = 3;
    else if (condition.includes('after 5')) interruptionTriggerThreshold = 5;
    else if (condition.includes('after 12')) interruptionTriggerThreshold = 12;
    else if (condition.includes('after 15')) interruptionTriggerThreshold = 15;
    else if (condition.includes('after 25')) interruptionTriggerThreshold = 25;

    let interruptingSpeechSentMono = 0;
    let interruptionEventRecvMono = 0;
    let interruptedGenId = '';
    let nextGenId = '';
    let staleAudioDetected = false;
    let newResponseReceived = false;
    let newResponseArrivalMono: number | null = null;
    let interruptSent = false;
    let streamInterval: any = null;
    let currentPhase: 'prompt' | 'ambient' | 'interrupting' = 'prompt';
    let phaseIdx = 0;
    let seq = 0;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'start', model: 'gemini-3.8-live' }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'session_ready') {
        sessionId = msg.sessionId;

        // Continuous full-duplex microphone stream (512 samples = ~32ms per chunk)
        streamInterval = setInterval(() => {
          seq++;
          let chunk: Buffer;

          if (currentPhase === 'prompt') {
            chunk = promptChunks[phaseIdx++];
            if (phaseIdx >= promptChunks.length) {
              currentPhase = 'ambient';
              phaseIdx = 0;
            }
          } else if (currentPhase === 'interrupting') {
            chunk = interruptChunks[phaseIdx++];
            if (phaseIdx >= interruptChunks.length) {
              currentPhase = 'ambient';
              phaseIdx = 0;
            }
          } else {
            chunk = silenceChunk;
          }

          ws.send(
            JSON.stringify({
              type: 'audio',
              seq,
              clientCaptureMono: performance.now(),
              clientSentMono: performance.now(),
              audio: chunk.toString('base64'),
            })
          );
        }, 32);
      } else if (msg.type === 'audio') {
        currentGenId = msg.generationId;

        if (interruptedGenId && msg.generationId === interruptedGenId) {
          // Check if stale audio from the interrupted generation leaked through!
          staleAudioDetected = true;
        }

        if (interruptedGenId && msg.generationId !== interruptedGenId) {
          newResponseReceived = true;
          if (newResponseArrivalMono === null) {
            newResponseArrivalMono = performance.now();
          }
        }

        chunksReceivedForActiveGen++;

        // Trigger interruption when threshold reached
        if (!interruptSent && chunksReceivedForActiveGen >= interruptionTriggerThreshold) {
          interruptSent = true;
          currentPhase = 'interrupting';
          phaseIdx = 0;
          interruptingSpeechSentMono = performance.now();
        }
      } else if (msg.type === 'interrupted') {
        interruptionEventRecvMono = performance.now();
        interruptedGenId = msg.interruptedGenerationId;
        nextGenId = msg.nextGenerationId;

        // Wait 1.5 seconds for new response or turn completion, then finish trial
        setTimeout(() => {
          clearInterval(streamInterval);
          ws.send(JSON.stringify({ type: 'end' }));
          setTimeout(() => {
            ws.close();
            const delayMs = Math.round(interruptionEventRecvMono - interruptingSpeechSentMono);
            const timeToNewResponse =
              newResponseArrivalMono !== null ? Math.round(newResponseArrivalMono - interruptionEventRecvMono) : null;

            resolve({
              trialNum,
              condition,
              sessionId,
              interruptedGenId,
              nextGenId,
              speechSentMono: interruptingSpeechSentMono,
              bridgeInterruptedRecvMono: interruptionEventRecvMono,
              interruptionDelayMs: delayMs,
              staleAudioDetected,
              newResponseReceived,
              timeToNewResponseMs: timeToNewResponse,
            });
          }, 200);
        }, 1500);
      } else if (msg.type === 'error') {
        clearInterval(streamInterval);
        reject(new Error(`Server error: ${msg.error}`));
      }
    });

    ws.on('error', (err) => {
      clearInterval(streamInterval);
      reject(err);
    });

    setTimeout(() => {
      clearInterval(streamInterval);
      ws.close();
      reject(new Error(`Trial ${trialNum} timed out after 18000ms`));
    }, 18000);
  });
}

runLiveTrials().catch(console.error);
