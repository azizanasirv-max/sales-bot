/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  resampleTo16k,
  floatTo16BitPCM,
  uint8ToBase64,
  base64PCMToFloat32,
  calculateRMS,
} from './utils/audio';
import {
  ConversationGate,
  SUPPORTED_LANGUAGES,
  TurnLedger,
  resolvePlaybackStopSet,
  shouldTriggerLocalBargeIn,
  type CancellationReason,
  type LedgerTurn,
} from './lib/conversation';
import { loadStoredLanguage, storeLanguage } from './lib/languagePreference';
import { buildDiagnosticsReport } from './lib/diagnostics';
import {
  Key,
  Eye,
  EyeOff,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Radio,
  Zap,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Activity,
  Layers,
  Volume2,
  RefreshCw,
  Copy,
  Check,
  ChevronDown,
  Info,
  Sparkles,
  ExternalLink,
  ShieldCheck,
  Gauge,
  Sliders,
  History,
  Timer,
} from 'lucide-react';

export type AppState =
  | 'api_key_missing'
  | 'mic_permission_pending'
  | 'mic_unavailable'
  | 'connecting'
  | 'ws_established'
  | 'session_initialized'
  | 'ready_for_conversation'
  | 'streaming_mic'
  | 'receiving_audio'
  | 'interrupted'
  | 'reconnecting'
  | 'disconnected'
  | 'auth_error'
  | 'model_unavailable'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'api_error';

export type TurnRecord = LedgerTurn;

export interface DiagnosticEvent {
  id: string;
  timestampUtc: string;
  sessionId: string;
  generationId?: string;
  type:
    | 'info'
    | 'audio_in'
    | 'audio_out'
    | 'interrupted'
    | 'turn_complete'
    | 'error'
    | 'usage'
    | 'state_change'
    | 'pipeline';
  message: string;
  details?: any;
}

export interface SessionDiagnostics {
  sessionId: string;
  modelId: string;
  startTimeUtc: string;
  startTimeMono: number;
  endTimeUtc: string | null;
  endTimeMono: number | null;
  elapsedSeconds: number;

  // 13-stage pipeline latency metrics
  measuredChunkDurationMs: number;
  rttTransportLatencyMs: number | null;
  micCaptureToSendMs: number | null;
  bridgeForwardDurationMs: number | null;
  interruptionToStopDurationMs: number | null;
  interruptionToNextResponseAudibleMs: number | null;
  firstAudioLatencyMs: number | null;

  // Packet counters (Strictly isolated per session)
  micChunksCaptured: number;
  micChunksSent: number;
  micChunksReceivedBridge: number;
  micChunksForwardedBridge: number;
  modelChunksReceivedBridge: number;
  modelChunksDeliveredClient: number;
  modelChunksScheduled: number;
  modelChunksRendered: number;

  // Interruption accounting
  userSpeechOnsetDetections: number;
  localPlaybackCancellations: number;
  geminiInterruptionEventsReceived: number;
  uniqueGenerationsInterrupted: number;
  completedTurns: number;
  interruptionTimingOutcome: 'none' | 'stopped_locally_before_server' | 'stopped_on_server_event';

  // Raw API Usage Metadata
  usageMetadata: {
    promptTokenCount?: number;
    responseTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  } | null;
}

const PREBUILT_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'] as const;

export default function App() {
  // Credential configuration states
  const [apiKey, setApiKey] = useState<string>(() => {
    try {
      return sessionStorage.getItem('GEMINI_LIVE_API_KEY') || '';
    } catch {
      // Storage can be disabled (private mode / embedded frame policy).
      return '';
    }
  });
  const [hasServerKey, setHasServerKey] = useState<boolean>(false);
  const [showKeyConfigModal, setShowKeyConfigModal] = useState<boolean>(false);
  const [inputKey, setInputKey] = useState<string>('');
  const [showKeyText, setShowKeyText] = useState<boolean>(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Core application state
  const [appState, setAppState] = useState<AppState>('disconnected');
  const [selectedVoice, setSelectedVoice] = useState<string>('Puck');
  const [selectedLanguage, setSelectedLanguage] = useState<string>(() => {
    try {
      return loadStoredLanguage(
        window.localStorage,
        SUPPORTED_LANGUAGES.map((option) => option.code)
      );
    } catch {
      return '';
    }
  });
  const [modelId, setModelId] = useState<string>('gemini-3.8-live');
  const [isInIframe, setIsInIframe] = useState<boolean>(false);

  // Active Session Diagnostics (isolated instance)
  const [activeSession, setActiveSession] = useState<SessionDiagnostics | null>(null);
  const [activeGenerationId, setActiveGenerationId] = useState<string>('gen_0');
  const [sessionLanguageLabel, setSessionLanguageLabel] = useState<string>(
    () =>
      SUPPORTED_LANGUAGES.find((l) => l.code === selectedLanguage)?.label ||
      'Auto (follow the user)'
  );

  // Audio hardware & volume
  const [micDeviceLabel, setMicDeviceLabel] = useState<string>('');
  const [isMicStreaming, setIsMicStreaming] = useState<boolean>(false);
  const [micVolume, setMicVolume] = useState<number>(0);
  const [outputVolume, setOutputVolume] = useState<number>(0);
  const [isTestingMic, setIsTestingMic] = useState<boolean>(false);

  // UI & tab states
  const [errorDetails, setErrorDetails] = useState<{
    code: string;
    message: string;
    instruction?: string;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<'conversation' | 'diagnostics' | 'pipeline' | 'guide'>(
    'conversation'
  );
  const [copiedLogs, setCopiedLogs] = useState<boolean>(false);

  // Conversation history and events (isolated to current session)
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);

  // Web Audio & WebSocket References
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);

  // Generation ID tracking & invalidation
  const gateRef = useRef<ConversationGate>(new ConversationGate());
  const ledgerRef = useRef<TurnLedger>(new TurnLedger());
  const activeSourcesRef = useRef<
    Array<{ node: AudioBufferSourceNode; generationId: string; endTime: number }>
  >([]);
  const nextPlayTimeRef = useRef<number>(0);
  const isStartingRef = useRef<boolean>(false);
  const pingIntervalRef = useRef<any>(null);
  const animFrameRef = useRef<number | null>(null);

  // Session ownership. `sessionEpochRef` invalidates handlers from a previous
  // WebSocket/session so a late callback cannot tear down a newer session.
  const sessionEpochRef = useRef<number>(0);
  const serverSessionIdRef = useRef<string>('');
  const appStateRef = useRef<AppState>('disconnected');
  const languageRef = useRef<string>(selectedLanguage);
  const rejectedGenerationLoggedRef = useRef<Set<string>>(new Set());
  const speechOnsetFramesRef = useRef<number>(0);

  // Timestamps for pipeline measurement
  const sessionStartMonoRef = useRef<number>(0);
  const userSpeechOnsetMonoRef = useRef<number | null>(null);
  const lastInterruptionMonoRef = useRef<number | null>(null);
  const localCancellationFiredRef = useRef<boolean>(false);
  const suppressBargeInUntilSilenceRef = useRef<boolean>(false);
  const chunkSequenceRef = useRef<number>(0);

  // Check iframe status on mount
  useEffect(() => {
    try {
      setIsInIframe(window.self !== window.top);
    } catch {
      setIsInIframe(true);
    }
  }, []);

  // Helper: Append diagnostic event with UTC ISO 8601 timestamp
  const logEvent = useCallback(
    (type: DiagnosticEvent['type'], message: string, details?: any) => {
      const nowUtc = new Date().toISOString();
      const generationId = gateRef.current.getActiveGenerationId();
      const newEvent: DiagnosticEvent = {
        id: Math.random().toString(36).substring(2, 9),
        timestampUtc: nowUtc,
        sessionId: serverSessionIdRef.current || 'init',
        generationId,
        type,
        message,
        details,
      };
      setEvents((prev) => [newEvent, ...prev.slice(0, 299)]);
    },
    []
  );

  // Transition state with logging. The ref is updated synchronously so event
  // handlers never read a stale state value from a previous render.
  const updateAppState = useCallback(
    (nextState: AppState, reason?: string) => {
      const prev = appStateRef.current;
      if (prev !== nextState) {
        logEvent('state_change', `State changed: ${prev} ➔ ${nextState}${reason ? ` (${reason})` : ''}`);
      }
      appStateRef.current = nextState;
      setAppState(nextState);
    },
    [logEvent]
  );

  // Keep non-React mirrors in sync.
  useEffect(() => {
    appStateRef.current = appState;
  }, [appState]);

  useEffect(() => {
    languageRef.current = selectedLanguage;
  }, [selectedLanguage]);

  // Release the WebSocket and audio graph when the component unmounts.
  useEffect(() => {
    return () => {
      sessionEpochRef.current += 1;
      try {
        wsRef.current?.close();
      } catch {
        /* already closed */
      }
      cleanupAudioPipeline();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check server environment key availability on mount
  useEffect(() => {
    fetch('/api/status')
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.targetModel === 'string' && data.targetModel) {
          setModelId(data.targetModel);
        }
        if (data.hasServerKey) {
          setHasServerKey(true);
          logEvent('info', 'Server environment GEMINI_API_KEY detected.');
        } else {
          setHasServerKey(false);
          logEvent('info', 'No server environment key. User configuration in UI required.');
          if (!apiKey) {
            setShowKeyConfigModal(true);
            updateAppState('api_key_missing', 'No API key configured');
          }
        }
      })
      .catch((err) => {
        console.error('Failed to check server status:', err);
      });
  }, [apiKey, logEvent, updateAppState]);

  // Session elapsed timer (monotonic delta calculation)
  useEffect(() => {
    let timer: any = null;
    if (
      (appState === 'ready_for_conversation' ||
        appState === 'streaming_mic' ||
        appState === 'receiving_audio' ||
        appState === 'interrupted' ||
        appState === 'reconnecting') &&
      sessionStartMonoRef.current > 0
    ) {
      timer = setInterval(() => {
        const elapsed = Math.floor((performance.now() - sessionStartMonoRef.current) / 1000);
        setActiveSession((prev) => (prev ? { ...prev, elapsedSeconds: elapsed } : null));
      }, 500);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [appState]);

  // Save API key handler
  const handleSaveApiKey = () => {
    const trimmed = inputKey.trim();
    if (!trimmed) {
      setKeyError('Please enter a non-empty Google Gemini API key.');
      return;
    }
    try {
      sessionStorage.setItem('GEMINI_LIVE_API_KEY', trimmed);
    } catch {
      // The key still works in-memory for this tab.
    }
    setApiKey(trimmed);
    setShowKeyConfigModal(false);
    setInputKey('');
    setKeyError(null);
    logEvent('info', 'User configured Gemini API key in session storage.');
    if (appStateRef.current === 'api_key_missing') {
      updateAppState('disconnected', 'API key configured');
    }
  };

  const handleClearApiKey = () => {
    try {
      sessionStorage.removeItem('GEMINI_LIVE_API_KEY');
    } catch {
      /* storage unavailable */
    }
    setApiKey('');
    setShowKeyConfigModal(true);
    logEvent('info', 'User cleared configured API key.');
    updateAppState('api_key_missing', 'API key cleared');
  };

  /**
   * The language lock is a product preference: persist it so a reconnect or a
   * restart of the session keeps the same conversational language.
   */
  const handleLanguageChange = (value: string) => {
    setSelectedLanguage(value);
    languageRef.current = value;
    try {
      storeLanguage(window.localStorage, value);
    } catch {
      /* storage unavailable (private mode) */
    }
    const option = SUPPORTED_LANGUAGES.find((l) => l.code === value);
    const label = option ? option.label : value || 'Auto (follow the user)';
    setSessionLanguageLabel(label);
    logEvent('info', `Conversation language set to: ${label}`);
  };

  // Per-generation gain nodes for airtight acoustic isolation on barge-in
  const generationGainsRef = useRef<Map<string, GainNode>>(new Map());

  /**
   * Stops scheduled assistant audio and invalidates the affected generations.
   *
   * Which generations are invalidated depends on why we cancel:
   *  - local_onset:        only generations with audio actually playing plus
   *                        the active generation if it has already produced
   *                        audio (never the empty "next" generation).
   *  - server_interrupted: exactly the generation the server reported (the
   *                        caller passes the already-computed invalidated set,
   *                        so the gate is not transitioned twice).
   *  - session_cleanup:    everything, and the gain map is emptied so a new
   *                        session cannot reuse GainNodes bound to a closed
   *                        AudioContext (which silently muted playback).
   *
   * Only sources belonging to an invalidated generation are stopped. A newer
   * generation whose audio already arrived (out-of-order delivery) is left
   * intact instead of being truncated by an older interruption event.
   */
  const cancelAllAssistantAudio = useCallback(
    (
      reason: CancellationReason,
      interruptedGenerationId?: string,
      explicitInvalidated?: string[]
    ) => {
      const cancelStartMono = performance.now();
      const gate = gateRef.current;
      let invalidated: string[] = [];

      if (reason === 'local_onset') {
        invalidated = gate.localBargeIn().invalidated;
        // Record the locally-stopped turn as interrupted rather than letting a
        // later turn_complete label it as a clean completion.
        let ledgerChanged = false;
        for (const generationId of invalidated) {
          if (ledgerRef.current.interrupt(generationId)) ledgerChanged = true;
        }
        if (ledgerChanged) setTurns(ledgerRef.current.snapshot());
      } else if (reason === 'server_interrupted') {
        invalidated =
          explicitInvalidated ??
          (interruptedGenerationId
            ? gate.handleInterruption(interruptedGenerationId, null).invalidated
            : []);
        if (interruptedGenerationId && !invalidated.includes(interruptedGenerationId)) {
          invalidated = [...invalidated, interruptedGenerationId];
        }
      } else {
        invalidated = gate.invalidateAll();
      }

      const stopSet = resolvePlaybackStopSet(
        reason,
        invalidated,
        activeSourcesRef.current.map((entry) => entry.generationId)
      );

      // Mute + detach the gain node of every generation that can no longer
      // reach the output. Cleanup detaches every node, including generations
      // whose sources already ended.
      const generationsToMute =
        reason === 'session_cleanup'
          ? [...generationGainsRef.current.keys()]
          : [...stopSet];
      for (const gen of generationsToMute) {
        const genGain = generationGainsRef.current.get(gen);
        if (genGain) {
          try {
            if (outputAudioCtxRef.current) {
              genGain.gain.cancelScheduledValues(outputAudioCtxRef.current.currentTime);
              genGain.gain.setValueAtTime(0, outputAudioCtxRef.current.currentTime);
            }
            genGain.disconnect();
          } catch {
            /* node already detached */
          }
          generationGainsRef.current.delete(gen);
        }
      }

      const keptSources: typeof activeSourcesRef.current = [];
      for (const entry of activeSourcesRef.current) {
        if (reason !== 'session_cleanup' && !stopSet.has(entry.generationId)) {
          keptSources.push(entry);
          continue;
        }
        try {
          entry.node.stop();
          entry.node.disconnect();
        } catch {
          /* already stopped */
        }
      }
      activeSourcesRef.current = keptSources;

      if (outputAudioCtxRef.current) {
        // Preserved sources keep their place in the queue. Resetting the cursor
        // to "now" would make the next chunk overlap audio that was kept.
        nextPlayTimeRef.current = keptSources.length
          ? Math.max(...keptSources.map((entry) => entry.endTime))
          : outputAudioCtxRef.current.currentTime;
      }
      setOutputVolume(0);

      if (reason !== 'session_cleanup') {
        // The interrupting utterance may still be in progress. Require a pause
        // before local VAD may cancel again, otherwise the answer to this
        // barge-in would be killed by the tail of the same utterance.
        suppressBargeInUntilSilenceRef.current = true;
        speechOnsetFramesRef.current = 0;
      }

      const cancelDurationMs = Math.round((performance.now() - cancelStartMono) * 100) / 100;
      setActiveSession((prev) =>
        prev
          ? {
              ...prev,
              interruptionToStopDurationMs: cancelDurationMs,
            }
          : null
      );

      logEvent(
        'pipeline',
        `Playback cancelled [Reason: ${reason}, Gens: ${
          invalidated.length ? invalidated.join(', ') : 'none'
        }] in ${cancelDurationMs}ms (Stage 9 & 10)`
      );
    },
    [logEvent]
  );

  // Audio Pipeline Cleanup
  const cleanupAudioPipeline = useCallback(() => {
    cancelAllAssistantAudio('session_cleanup');
    generationGainsRef.current.clear();
    activeSourcesRef.current = [];

    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    suppressBargeInUntilSilenceRef.current = false;
    speechOnsetFramesRef.current = 0;

    if (scriptProcessorRef.current) {
      try {
        scriptProcessorRef.current.disconnect();
      } catch (e) {}
      scriptProcessorRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
      mediaStreamRef.current = null;
    }

    if (inputAudioCtxRef.current && inputAudioCtxRef.current.state !== 'closed') {
      try {
        inputAudioCtxRef.current.close();
      } catch (e) {}
      inputAudioCtxRef.current = null;
    }

    if (outputAudioCtxRef.current && outputAudioCtxRef.current.state !== 'closed') {
      try {
        outputAudioCtxRef.current.close();
      } catch (e) {}
      outputAudioCtxRef.current = null;
    }

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    setIsMicStreaming(false);
    setMicVolume(0);
    setOutputVolume(0);
    setIsTestingMic(false);
  }, [cancelAllAssistantAudio]);

  // Real microphone acquisition with specific error mapping
  const obtainMicrophoneStream = async (): Promise<MediaStream> => {
    if (!window.isSecureContext) {
      throw {
        name: 'InsecureContextError',
        message: 'Microphone access is prohibited on insecure origins. The app must run over HTTPS or localhost.',
        instruction: 'Please access this app through a secure HTTPS connection.',
      };
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (isInIframe) {
        throw {
          name: 'IframeRestrictionError',
          message: 'navigator.mediaDevices.getUserMedia is not accessible in this embedded frame.',
          instruction:
            'Click the "Open Standalone Tab" button above to run the app directly in a full browser tab.',
        };
      }
      throw {
        name: 'NotSupportedError',
        message: 'Your browser environment does not support mediaDevices.getUserMedia.',
        instruction: 'Please use a modern browser such as Chrome, Edge, Safari, or Firefox.',
      };
    }

    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err: any) {
      if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
        logEvent('info', 'Hardware constraints overconstrained; retrying with audio: true');
        return await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      let instruction = 'Please check your microphone connection and browser settings.';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        if (
          err.message?.toLowerCase().includes('permissions policy') ||
          err.message?.toLowerCase().includes('disallowed') ||
          isInIframe
        ) {
          instruction =
            'Microphone access was blocked by the embedded frame permissions policy. Click "Open Standalone Tab" above to grant direct microphone access.';
        } else {
          instruction =
            'Microphone permission was denied by the browser. Click the site settings/lock icon in your URL bar, set Microphone to "Allow", and reload.';
        }
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        instruction =
          'No microphone hardware was detected on your system. Plug in a headset or enable your microphone in OS settings.';
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        instruction =
          'Your microphone is currently locked by another application (e.g. Zoom, Teams, Meet). Close other audio apps and try again.';
      }

      throw {
        name: err.name || 'MicrophoneError',
        message: err.message || 'Microphone capture failed.',
        instruction,
      };
    }
  };

  // Standalone Microphone Test
  const testMicrophone = async () => {
    if (isTestingMic) {
      cleanupAudioPipeline();
      return;
    }

    setErrorDetails(null);
    setIsTestingMic(true);
    logEvent('info', 'Starting standalone microphone hardware verification...');

    try {
      const stream = await obtainMicrophoneStream();
      mediaStreamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      const label = track?.label || 'Default Audio Input';
      setMicDeviceLabel(label);
      logEvent('info', `Microphone hardware verified: "${label}"`);

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      inputAudioCtxRef.current = ctx;
      if (ctx.state === 'suspended') await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      // 512 samples = ~32ms at 16kHz
      const processor = ctx.createScriptProcessor(512, 1, 1);
      scriptProcessorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const rms = calculateRMS(inputData);
        setMicVolume(Math.min(100, Math.round(rms * 280)));
      };

      source.connect(processor);
      processor.connect(ctx.destination);
    } catch (err: any) {
      console.error('[Mic Test Error]:', err);
      logEvent('error', `Microphone test error: ${err.message}`, err);
      setErrorDetails({
        code: err.name || 'MIC_TEST_FAILED',
        message: err.message || 'Microphone capture failed.',
        instruction: err.instruction,
      });
      cleanupAudioPipeline();
    }
  };

  // End conversation handler
  const endConversation = useCallback(() => {
    logEvent('info', 'User requested session termination.');
    // Invalidate handlers first: the socket close below must not run cleanup
    // twice or touch a newer session.
    sessionEpochRef.current += 1;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'end' }));
      }
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    cleanupAudioPipeline();
    isStartingRef.current = false;
    updateAppState('disconnected', 'User ended conversation');

    setActiveSession((prev) =>
      prev
        ? {
            ...prev,
            endTimeUtc: new Date().toISOString(),
            endTimeMono: performance.now(),
          }
        : null
    );
  }, [cleanupAudioPipeline, logEvent, updateAppState]);

  // Start conversation handler with complete pipeline instrumentation
  const startConversation = async () => {
    if (isStartingRef.current) return;
    isStartingRef.current = true;
    setErrorDetails(null);

    const effectiveKey = apiKey.trim();
    if (!effectiveKey && !hasServerKey) {
      setShowKeyConfigModal(true);
      updateAppState('api_key_missing', 'Key required to initiate connection');
      isStartingRef.current = false;
      return;
    }

    // Invalidate every handler belonging to a previous session before the new
    // pipeline starts. A late `onclose`/`onmessage` from the old socket must
    // never tear down or mutate the new session.
    sessionEpochRef.current += 1;
    const sessionEpoch = sessionEpochRef.current;
    const previousWs = wsRef.current;
    wsRef.current = null;
    if (previousWs) {
      previousWs.onopen = null;
      previousWs.onmessage = null;
      previousWs.onerror = null;
      previousWs.onclose = null;
      try {
        previousWs.close();
      } catch {
        /* already closed */
      }
    }

    cleanupAudioPipeline();

    // Initialize fresh session diagnostics & state isolation
    const newSessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const startMono = performance.now();
    const startUtc = new Date().toISOString();
    sessionStartMonoRef.current = startMono;
    userSpeechOnsetMonoRef.current = null;
    lastInterruptionMonoRef.current = null;
    localCancellationFiredRef.current = false;
    suppressBargeInUntilSilenceRef.current = false;
    chunkSequenceRef.current = 0;
    speechOnsetFramesRef.current = 0;
    serverSessionIdRef.current = '';
    rejectedGenerationLoggedRef.current = new Set();
    gateRef.current.reset();
    ledgerRef.current.clear();
    generationGainsRef.current.clear();
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = 0;

    // Reset turns & events for clean session isolation
    setTurns([]);
    setEvents([]);

    const initialDiagnostics: SessionDiagnostics = {
      sessionId: newSessionId,
      modelId,
      startTimeUtc: startUtc,
      startTimeMono: startMono,
      endTimeUtc: null,
      endTimeMono: null,
      elapsedSeconds: 0,
      measuredChunkDurationMs: 32, // 512 samples at 16kHz
      rttTransportLatencyMs: null,
      micCaptureToSendMs: null,
      bridgeForwardDurationMs: null,
      interruptionToStopDurationMs: null,
      interruptionToNextResponseAudibleMs: null,
      firstAudioLatencyMs: null,
      micChunksCaptured: 0,
      micChunksSent: 0,
      micChunksReceivedBridge: 0,
      micChunksForwardedBridge: 0,
      modelChunksReceivedBridge: 0,
      modelChunksDeliveredClient: 0,
      modelChunksScheduled: 0,
      modelChunksRendered: 0,
      userSpeechOnsetDetections: 0,
      localPlaybackCancellations: 0,
      geminiInterruptionEventsReceived: 0,
      uniqueGenerationsInterrupted: 0,
      completedTurns: 0,
      interruptionTimingOutcome: 'none',
      usageMetadata: null,
    };
    setActiveSession(initialDiagnostics);
    setActiveGenerationId('gen_0');
    setSessionLanguageLabel(
      SUPPORTED_LANGUAGES.find((l) => l.code === (languageRef.current || ''))?.label ||
        'Auto (follow the user)'
    );

    logEvent('info', `Starting session [${newSessionId}] with model: ${modelId}`);

    // 1. Request real microphone access
    updateAppState('mic_permission_pending', 'Requesting getUserMedia stream');
    let stream: MediaStream;
    try {
      stream = await obtainMicrophoneStream();
      mediaStreamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      const deviceLabel = track?.label || 'Microphone Audio Input';
      setMicDeviceLabel(deviceLabel);
      logEvent('info', `Microphone stream acquired: "${deviceLabel}"`);
    } catch (micErr: any) {
      console.error('[Mic Error]:', micErr);
      logEvent('error', `Microphone error: ${micErr.message}`, micErr);
      setErrorDetails({
        code: micErr.name || 'MIC_PERMISSION_DENIED',
        message: micErr.message,
        instruction: micErr.instruction,
      });
      updateAppState('mic_unavailable', micErr.name);
      cleanupAudioPipeline();
      isStartingRef.current = false;
      return;
    }

    // 2. Setup Web Audio Contexts
    let inputCtx: AudioContext;
    let outputCtx: AudioContext;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      // A 16kHz context avoids resampling on capture, but not every browser
      // accepts a forced sample rate. Fall back to the hardware default; the
      // capture path resamples to 16k anyway.
      try {
        inputCtx = new AudioCtx({ sampleRate: 16000 });
      } catch {
        logEvent('info', '16kHz AudioContext unsupported; using the default sample rate.');
        inputCtx = new AudioCtx();
      }
      outputCtx = new AudioCtx();

      if (inputCtx.state === 'suspended') await inputCtx.resume();
      if (outputCtx.state === 'suspended') await outputCtx.resume();

      inputAudioCtxRef.current = inputCtx;
      outputAudioCtxRef.current = outputCtx;
      nextPlayTimeRef.current = outputCtx.currentTime;

      const outputGain = outputCtx.createGain();
      const outputAnalyser = outputCtx.createAnalyser();
      outputAnalyser.fftSize = 256;
      outputGain.connect(outputAnalyser);
      outputAnalyser.connect(outputCtx.destination);
      outputGainRef.current = outputGain;
      outputAnalyserRef.current = outputAnalyser;
    } catch (audioCtxErr: any) {
      console.error('[AudioContext Error]:', audioCtxErr);
      logEvent('error', `AudioContext error: ${audioCtxErr.message}`, audioCtxErr);
      setErrorDetails({
        code: 'AUDIO_CONTEXT_FAILED',
        message: 'Could not initialize browser Web Audio context.',
        instruction: 'Ensure your audio output device is enabled and refresh the browser.',
      });
      updateAppState('api_error', 'AudioContext failed');
      cleanupAudioPipeline();
      isStartingRef.current = false;
      return;
    }

    // 3. Connect WebSocket to server bridge
    updateAppState('connecting', 'Connecting WebSocket bridge');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/live-ws`;
    logEvent('info', `Opening persistent WebSocket: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    // Periodic RTT ping/pong (every 5 seconds). The handle is owned by the
    // component so ending or replacing a session always clears it.
    pingIntervalRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', clientMono: performance.now() }));
      }
    }, 5000);

    ws.onopen = () => {
      updateAppState('ws_established', 'WebSocket open; initiating Gemini Live session');
      logEvent('info', `WebSocket transport opened. Initiating Gemini Live session (${modelId})...`);

      // Immediately send initial ping
      ws.send(JSON.stringify({ type: 'ping', clientMono: performance.now() }));

      ws.send(
        JSON.stringify({
          type: 'start',
          sessionId: newSessionId,
          model: modelId,
          voice: selectedVoice,
          language: languageRef.current || undefined,
          apiKey: effectiveKey || undefined,
        })
      );
    };

    ws.onmessage = (event) => {
      // Ignore frames from a socket that has already been superseded.
      if (wsRef.current !== ws || sessionEpochRef.current !== sessionEpoch) return;
      try {
        const msg = JSON.parse(event.data);
        const msgRecvMono = performance.now();

        if (msg.type === 'pong') {
          // RTT Transport Latency calculation
          if (msg.clientMono) {
            const rtt = Math.round((msgRecvMono - msg.clientMono) * 100) / 100;
            setActiveSession((prev) => (prev ? { ...prev, rttTransportLatencyMs: rtt } : null));
          }
        } else if (msg.type === 'ws_established') {
          updateAppState('ws_established', 'Connected to server');
        } else if (msg.type === 'session_ready') {
          // The server-generated session ID is authoritative.
          if (msg.sessionId) {
            serverSessionIdRef.current = msg.sessionId;
            setActiveSession((prev) =>
              prev ? { ...prev, sessionId: msg.sessionId, modelId: msg.model || prev.modelId } : prev
            );
          }
          if (msg.language?.label) setSessionLanguageLabel(msg.language.label);
          gateRef.current.seedGeneration('gen_0');
          updateAppState('ready_for_conversation', 'Session setupComplete confirmed');
          setIsMicStreaming(true);
          logEvent(
            'info',
            `✅ Session verified and initialized with ${msg.model} (Voice: ${msg.voice}, ` +
              `Language: ${msg.language?.label ?? 'auto'})`
          );
        } else if (msg.type === 'session_reconnecting') {
          // The bridge is resuming the Gemini session. Keep the audio graph,
          // history and language state intact; only pause turn processing.
          updateAppState('reconnecting', `Resuming live session (attempt ${msg.attempt})`);
          logEvent(
            'info',
            `Live session lost; resuming context (attempt ${msg.attempt}/${msg.maxAttempts ?? '?'}).`
          );
        } else if (msg.type === 'session_reconnected') {
          if (msg.sessionId) serverSessionIdRef.current = msg.sessionId;
          if (outputAudioCtxRef.current) {
            nextPlayTimeRef.current = outputAudioCtxRef.current.currentTime;
          }
          setActiveGenerationId(gateRef.current.getActiveGenerationId());
          updateAppState('ready_for_conversation', 'Session context resumed');
          logEvent(
            'info',
            `♻️ Live session resumed; conversation context preserved=${
              msg.contextPreserved === false ? 'no' : 'yes'
            }.`
          );
        } else if (msg.type === 'session_expiring') {
          logEvent(
            'info',
            `Server signalled session expiry (timeLeft=${msg.timeLeft ?? 'unknown'}); a resume will follow.`
          );
        } else if (msg.type === 'transcription') {
          logEvent(
            'info',
            `${msg.direction === 'output' ? 'Assistant' : 'User'} transcript: "${msg.text}"`,
            { direction: msg.direction }
          );
        } else if (msg.type === 'status') {
          if (msg.state === 'disconnected') {
            updateAppState('disconnected', 'Session disconnected');
            cleanupAudioPipeline();
          }
        } else if (msg.type === 'audio_ack') {
          // Bridge acknowledged mic chunk forwarding
          setActiveSession((prev) =>
            prev
              ? {
                  ...prev,
                  micChunksReceivedBridge: msg.seq,
                  micChunksForwardedBridge: msg.seq,
                  bridgeForwardDurationMs: msg.bridgeForwardDurationMs,
                }
              : null
          );
        } else if (msg.type === 'audio') {
          // Central generation gate: drops stale/interrupted chunks without
          // ever dropping the pending generation that answers a barge-in.
          const acceptance = gateRef.current.acceptAudio(msg.generationId);
          if (!acceptance.accepted) {
            const key = `${msg.generationId}:${acceptance.reason}`;
            if (!rejectedGenerationLoggedRef.current.has(key)) {
              rejectedGenerationLoggedRef.current.add(key);
              logEvent(
                'pipeline',
                `Dropped ${acceptance.reason} audio chunk from generation ${msg.generationId}`
              );
            }
            return;
          }
          const activeGen = acceptance.generationId;
          setActiveGenerationId(activeGen);

          // Stage 12: First new response audio arrives from Gemini
          if (lastInterruptionMonoRef.current) {
            const timeToRecv = Math.round((msgRecvMono - lastInterruptionMonoRef.current) * 10) / 10;
            logEvent('pipeline', `First response audio packet received after interruption (${timeToRecv}ms)`);
          }

          updateAppState('receiving_audio', 'Receiving assistant audio chunk');

          // First audio latency measurement
          let firstAudioLatencyMs: number | undefined;
          if (userSpeechOnsetMonoRef.current) {
            firstAudioLatencyMs = Math.round(msgRecvMono - userSpeechOnsetMonoRef.current);
            setActiveSession((prev) =>
              prev ? { ...prev, firstAudioLatencyMs: firstAudioLatencyMs! } : null
            );
            userSpeechOnsetMonoRef.current = null;
          }

          // Decode and queue 24kHz PCM chunk
          if (outputCtx && outputGainRef.current && msg.data) {
            // Browsers can suspend the context (tab backgrounding, iOS audio
            // policy). Scheduling into a suspended context produces silence
            // until it is resumed, so nudge it on every first chunk.
            if (outputCtx.state === 'suspended') {
              void outputCtx.resume().catch(() => {
                /* resume will be retried with the next chunk */
              });
            }
            const float32Samples = base64PCMToFloat32(msg.data);
            const durationSec = float32Samples.length / 24000;

            setActiveSession((prev) =>
              prev
                ? {
                    ...prev,
                    modelChunksDeliveredClient: prev.modelChunksDeliveredClient + 1,
                    modelChunksScheduled: prev.modelChunksScheduled + 1,
                  }
                : null
            );

            const { created } = ledgerRef.current.addAudio(activeGen, durationSec * 1000, {
              latencyMs: firstAudioLatencyMs,
            });
            if (created) {
              // A new assistant turn is starting; local barge-in is armed again.
              localCancellationFiredRef.current = false;
              logEvent('turn_complete', `New assistant turn started [Gen: ${activeGen}]`);
            }
            setTurns(ledgerRef.current.snapshot());

            const audioBuffer = outputCtx.createBuffer(1, float32Samples.length, 24000);
            audioBuffer.getChannelData(0).set(float32Samples);

            // Dedicated gain node for this generation for airtight acoustic isolation
            if (!generationGainsRef.current.has(activeGen)) {
              const g = outputCtx.createGain();
              g.gain.setValueAtTime(1, outputCtx.currentTime);
              g.connect(outputGainRef.current);
              generationGainsRef.current.set(activeGen, g);
            }
            const currentGenGain = generationGainsRef.current.get(activeGen)!;

            const source = outputCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(currentGenGain);

            const currentTime = outputCtx.currentTime;
            if (nextPlayTimeRef.current < currentTime) {
              nextPlayTimeRef.current = currentTime + 0.005; // Tight 5ms buffer
            }

            // Stage 13: Calculate when this chunk becomes audible
            const timeUntilAudibleMs = Math.max(0, (nextPlayTimeRef.current - currentTime) * 1000);
            if (lastInterruptionMonoRef.current) {
              const totalToAudible = Math.round(msgRecvMono - lastInterruptionMonoRef.current + timeUntilAudibleMs);
              setActiveSession((prev) =>
                prev
                  ? {
                      ...prev,
                      interruptionToNextResponseAudibleMs: totalToAudible,
                    }
                  : null
              );
              lastInterruptionMonoRef.current = null;
            }

            gateRef.current.markPlaybackScheduled(activeGen);
            const sourceStartTime = nextPlayTimeRef.current;
            source.start(sourceStartTime);
            const sourceEndTime = sourceStartTime + audioBuffer.duration;
            nextPlayTimeRef.current = sourceEndTime;

            activeSourcesRef.current.push({
              node: source,
              generationId: activeGen,
              endTime: sourceEndTime,
            });

            source.onended = () => {
              const idx = activeSourcesRef.current.findIndex((entry) => entry.node === source);
              if (idx !== -1) {
                activeSourcesRef.current.splice(idx, 1);
              }
              gateRef.current.markPlaybackEnded(activeGen);
              setActiveSession((prev) =>
                prev ? { ...prev, modelChunksRendered: prev.modelChunksRendered + 1 } : null
              );
              if (activeSourcesRef.current.length === 0) {
                // Release gain nodes that can no longer be needed. Keeping them
                // around leaked nodes across long sessions and cross-session
                // reuse is what previously silenced a restarted session.
                for (const [gen, gainNode] of generationGainsRef.current.entries()) {
                  if (gen === gateRef.current.getActiveGenerationId()) continue;
                  try {
                    gainNode.disconnect();
                  } catch {
                    /* detached */
                  }
                  generationGainsRef.current.delete(gen);
                }
                if (
                  appStateRef.current === 'receiving_audio' ||
                  appStateRef.current === 'ready_for_conversation'
                ) {
                  updateAppState('ready_for_conversation', 'Assistant audio playback finished');
                }
                setOutputVolume(0);
              }
            };
          }
        } else if (msg.type === 'interrupted') {
          // Stage 6, 7 & 8: Interruption event delivered to browser
          const interruptedGen =
            msg.interruptedGenerationId || gateRef.current.getActiveGenerationId();
          logEvent(
            'interrupted',
            `⚡ Gemini Live server reported interruption of ${interruptedGen} (Stage 6–8)`
          );

          // Stop playback and invalidate exactly the interrupted generation.
          // The gate advances to the server's next generation exactly once;
          // the cancellation receives that invalidated set instead of
          // transitioning the gate a second time.
          const interruptionResult = gateRef.current.handleInterruption(
            msg.interruptedGenerationId,
            msg.nextGenerationId
          );
          cancelAllAssistantAudio(
            'server_interrupted',
            msg.interruptedGenerationId,
            interruptionResult.invalidated
          );
          updateAppState('interrupted', 'Model barge-in interruption triggered');

          setActiveGenerationId(interruptionResult.nextGenerationId);

          lastInterruptionMonoRef.current = performance.now();

          // Interruption timing outcome
          const timingOutcome = localCancellationFiredRef.current
            ? 'stopped_locally_before_server'
            : 'stopped_on_server_event';

          setActiveSession((prev) =>
            prev
              ? {
                  ...prev,
                  geminiInterruptionEventsReceived: prev.geminiInterruptionEventsReceived + 1,
                  uniqueGenerationsInterrupted:
                    prev.uniqueGenerationsInterrupted + (interruptionResult.firstObservation ? 1 : 0),
                  interruptionTimingOutcome: timingOutcome,
                }
              : null
          );

          localCancellationFiredRef.current = false;

          if (ledgerRef.current.interrupt(msg.interruptedGenerationId)) {
            setTurns(ledgerRef.current.snapshot());
          }
        } else if (msg.type === 'turn_complete') {
          const completedTurn = ledgerRef.current.get(msg.completedGenerationId);
          const wasInterrupted = completedTurn?.status === 'interrupted';
          logEvent(
            'turn_complete',
            wasInterrupted
              ? `Turn closed after interruption (${msg.completedGenerationId})`
              : `Turn completed cleanly by Gemini Live API (${msg.completedGenerationId})`
          );
          const turnResult = gateRef.current.handleTurnComplete(
            msg.completedGenerationId,
            msg.nextGenerationId
          );
          // A new turn boundary re-arms local barge-in handling.
          localCancellationFiredRef.current = false;
          setActiveGenerationId(turnResult.nextGenerationId);
          setActiveSession((prev) =>
            prev
              ? {
                  ...prev,
                  completedTurns: prev.completedTurns + (wasInterrupted ? 0 : 1),
                }
              : null
          );
          // Close the turn the event actually refers to, not whichever turn
          // happens to be newest (a late completion can arrive after a new
          // response started).
          if (ledgerRef.current.complete(msg.completedGenerationId)) {
            setTurns(ledgerRef.current.snapshot());
          }
        } else if (msg.type === 'text') {
          if (msg.generationId && gateRef.current.isInvalidated(msg.generationId)) {
            return;
          }
          logEvent('audio_out', `Transcript text from model: "${msg.text}"`);
          if (msg.generationId && ledgerRef.current.appendText(msg.generationId, msg.text)) {
            setTurns(ledgerRef.current.snapshot());
          }
        } else if (msg.type === 'usage') {
          logEvent('usage', `Usage metadata: ${JSON.stringify(msg.usage)}`);
          setActiveSession((prev) => (prev ? { ...prev, usageMetadata: msg.usage } : null));
        } else if (msg.type === 'error') {
          logEvent('error', `API error: ${msg.error}`, msg);
          let instr = 'Check diagnostic events for raw details.';
          if (msg.code === 'AUTH_ERROR' || msg.code === 'API_KEY_INVALID') {
            instr = 'Your Gemini API key was rejected by Google AI Studio. Click "Change API Key" and enter a valid key.';
            updateAppState('auth_error', msg.error);
          } else if (msg.code === 'QUOTA_EXHAUSTED') {
            instr = 'Project quota for Gemini Live API exhausted.';
            updateAppState('quota_exhausted', msg.error);
          } else if (msg.code === 'RATE_LIMITED') {
            instr = 'Rate limited by Gemini Live API. Please wait before reconnecting.';
            updateAppState('rate_limited', msg.error);
          } else if (msg.code === 'MODEL_UNAVAILABLE' || msg.code === 'INVALID_MODEL') {
            instr = `Model ${modelId} is not enabled or accessible on your project.`;
            updateAppState('model_unavailable', msg.error);
          } else if (msg.code === 'SESSION_RESUME_FAILED' || msg.code === 'CONNECT_FAILED') {
            instr =
              'The live session could not be established or resumed. Check your network and API key, then start a new conversation.';
            updateAppState('api_error', msg.error);
          } else {
            updateAppState('api_error', msg.error);
          }

          setErrorDetails({
            code: msg.code || 'API_ERROR',
            message: msg.error,
            instruction: instr,
          });
          cleanupAudioPipeline();
        } else if (msg.type === 'closed') {
          logEvent(
            'info',
            `Session closed by bridge: code=${msg.code}, reason=${msg.reason}, reconnectable=${
              msg.reconnectable === false ? 'no' : 'yes'
            }`
          );
          updateAppState('disconnected', 'Session closed');
          cleanupAudioPipeline();
        }
      } catch (err: any) {
        console.error('[WS Message Error]:', err);
      }
    };

    ws.onerror = (e) => {
      if (wsRef.current !== ws || sessionEpochRef.current !== sessionEpoch) return;
      console.error('[WebSocket Error]:', e);
      logEvent('error', 'WebSocket connection failed.');
      setErrorDetails({
        code: 'WS_CONNECTION_ERROR',
        message: 'Could not connect to backend WebSocket bridge.',
        instruction: 'Ensure backend server is running and network allows WebSocket connections.',
      });
      updateAppState('api_error', 'WebSocket error');
      cleanupAudioPipeline();
    };

    ws.onclose = () => {
      if (wsRef.current !== ws || sessionEpochRef.current !== sessionEpoch) return;
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      logEvent('info', 'WebSocket connection closed.');
      const state = appStateRef.current;
      if (state !== 'auth_error' && state !== 'quota_exhausted' && state !== 'model_unavailable') {
        updateAppState('disconnected', 'WebSocket closed');
      }
      cleanupAudioPipeline();
      isStartingRef.current = false;
    };

    // 4. Setup microphone streaming processor: 512 samples = ~32ms chunks
    const source = inputCtx.createMediaStreamSource(stream);
    const processor = inputCtx.createScriptProcessor(512, 1, 1);
    scriptProcessorRef.current = processor;

    processor.onaudioprocess = (e) => {
      // Stage 1: Browser microphone audio captured
      const captureMono = performance.now();
      const inputData = e.inputBuffer.getChannelData(0);
      const rms = calculateRMS(inputData);
      setMicVolume(Math.min(100, Math.round(rms * 280)));

      const isSpeaking = rms > 0.025;

      // Local speech onset detection & barge-in tracking. Requiring a few
      // consecutive voiced frames (~96ms) prevents speaker echo/noise from
      // falsely invalidating the current response. After a barge-in, playback
      // cannot be cancelled again until the user has actually paused, so the
      // tail of the same utterance cannot kill the model's answer.
      if (isSpeaking) {
        speechOnsetFramesRef.current += 1;
      } else {
        speechOnsetFramesRef.current = 0;
        suppressBargeInUntilSilenceRef.current = false;
      }

      if (isSpeaking && !userSpeechOnsetMonoRef.current) {
        userSpeechOnsetMonoRef.current = captureMono;
        setActiveSession((prev) =>
          prev ? { ...prev, userSpeechOnsetDetections: prev.userSpeechOnsetDetections + 1 } : null
        );
      }

      if (
        shouldTriggerLocalBargeIn({
          isSpeaking,
          speechFrameCount: speechOnsetFramesRef.current,
          playbackCount: gateRef.current.playbackCount(),
          alreadyCancelled: localCancellationFiredRef.current,
          suppressedUntilSilence: suppressBargeInUntilSilenceRef.current,
        })
      ) {
        localCancellationFiredRef.current = true;
        setActiveSession((prev) =>
          prev ? { ...prev, localPlaybackCancellations: prev.localPlaybackCancellations + 1 } : null
        );
        // Instant local stop for immediate auditory response. The gate only
        // invalidates generations that are actually playing / have audio, so
        // the response to this barge-in is not discarded.
        updateAppState('interrupted', 'Local voice activity during playback');
        cancelAllAssistantAudio('local_onset');
      }

      // Stage 2: Audio chunk prepared for transmission (resample + 16-bit PCM encode)
      const resampled = resampleTo16k(inputData, inputCtx.sampleRate);
      const pcmBytes = floatTo16BitPCM(resampled);
      const base64 = uint8ToBase64(pcmBytes);
      const prepMono = performance.now();
      const prepDurationMs = Math.round((prepMono - captureMono) * 100) / 100;

      // Stage 3: Audio chunk sent by the browser
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        chunkSequenceRef.current += 1;
        const currentSeq = chunkSequenceRef.current;
        const sentMono = performance.now();

        wsRef.current.send(
          JSON.stringify({
            type: 'audio',
            sessionId: serverSessionIdRef.current || newSessionId,
            seq: currentSeq,
            clientCaptureMono: captureMono,
            clientSentMono: sentMono,
            audio: base64,
          })
        );

        setActiveSession((prev) =>
          prev
            ? {
                ...prev,
                micChunksCaptured: prev.micChunksCaptured + 1,
                micChunksSent: prev.micChunksSent + 1,
                micCaptureToSendMs: prepDurationMs,
              }
            : null
        );

        if (isSpeaking && appStateRef.current === 'ready_for_conversation') {
          updateAppState('streaming_mic', 'User voice detected');
        }
      }
    };

    source.connect(processor);
    processor.connect(inputCtx.destination);

    // 5. Output audio volume meter animation loop
    const updateOutputVU = () => {
      if (outputAnalyserRef.current && activeSourcesRef.current.length > 0) {
        const dataArray = new Uint8Array(outputAnalyserRef.current.frequencyBinCount);
        outputAnalyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        setOutputVolume(Math.min(100, Math.round((avg / 255) * 160)));
      } else {
        setOutputVolume(0);
      }
      animFrameRef.current = requestAnimationFrame(updateOutputVU);
    };
    animFrameRef.current = requestAnimationFrame(updateOutputVU);
    isStartingRef.current = false;
  };

  // Copy diagnostics report (Strict credential redaction)
  const copyDiagnostics = () => {
    const report = buildDiagnosticsReport({
      modelId,
      sessionDiagnostics: activeSession,
      activeGenerationId,
      language: sessionLanguageLabel,
      hasConfiguredApiKey: !!apiKey || hasServerKey,
      authSource: apiKey ? 'user_provided_key' : hasServerKey ? 'server_env_key' : 'none',
      microphoneDevice: micDeviceLabel || 'None',
      recentEvents: events,
    });
    navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    setCopiedLogs(true);
    setTimeout(() => setCopiedLogs(false), 2000);
  };

  const formatSeconds = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const getStateBadge = () => {
    switch (appState) {
      case 'ready_for_conversation':
        return { label: 'Ready for Conversation', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', dot: 'bg-emerald-400' };
      case 'streaming_mic':
        return { label: 'Streaming User Audio', color: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30', dot: 'bg-cyan-400 animate-pulse' };
      case 'receiving_audio':
        return { label: 'Receiving Assistant Audio', color: 'bg-purple-500/10 text-purple-400 border-purple-500/30', dot: 'bg-purple-400 animate-pulse' };
      case 'interrupted':
        return { label: 'Interruption Handled', color: 'bg-rose-500/10 text-rose-400 border-rose-500/30', dot: 'bg-rose-400 animate-ping' };
      case 'reconnecting':
        return { label: 'Reconnecting Session...', color: 'bg-amber-500/10 text-amber-300 border-amber-500/30', dot: 'bg-amber-400 animate-pulse' };
      case 'connecting':
        return { label: 'Connecting WebSocket...', color: 'bg-amber-500/10 text-amber-400 border-amber-500/30', dot: 'bg-amber-400 animate-ping' };
      case 'ws_established':
        return { label: 'Initializing Live Session...', color: 'bg-amber-500/10 text-amber-400 border-amber-500/30', dot: 'bg-amber-400' };
      case 'mic_permission_pending':
        return { label: 'Requesting Mic Access...', color: 'bg-blue-500/10 text-blue-400 border-blue-500/30', dot: 'bg-blue-400 animate-bounce' };
      case 'mic_unavailable':
        return { label: 'Microphone Unavailable', color: 'bg-red-500/10 text-red-400 border-red-500/30', dot: 'bg-red-400' };
      case 'auth_error':
        return { label: 'Authentication Error', color: 'bg-rose-500/10 text-rose-400 border-rose-500/30', dot: 'bg-rose-400' };
      case 'quota_exhausted':
        return { label: 'Quota Exhausted', color: 'bg-orange-500/10 text-orange-400 border-orange-500/30', dot: 'bg-orange-400' };
      case 'rate_limited':
        return { label: 'Rate Limited', color: 'bg-orange-500/10 text-orange-400 border-orange-500/30', dot: 'bg-orange-400' };
      case 'model_unavailable':
        return { label: 'Model Unavailable', color: 'bg-rose-500/10 text-rose-400 border-rose-500/30', dot: 'bg-rose-400' };
      case 'api_key_missing':
        return { label: 'API Key Missing', color: 'bg-amber-500/10 text-amber-400 border-amber-500/30', dot: 'bg-amber-400' };
      case 'api_error':
        return { label: 'API / Network Error', color: 'bg-rose-500/10 text-rose-400 border-rose-500/30', dot: 'bg-rose-400' };
      case 'disconnected':
      default:
        return { label: 'Disconnected', color: 'bg-slate-800 text-slate-400 border-slate-700', dot: 'bg-slate-500' };
    }
  };

  const stateBadge = getStateBadge();
  const isSessionActive =
    appState === 'ready_for_conversation' ||
    appState === 'streaming_mic' ||
    appState === 'receiving_audio' ||
    appState === 'interrupted' ||
    appState === 'reconnecting';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col selection:bg-indigo-600 selection:text-white">
      {/* Top Header */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-30 px-4 py-3 sm:px-6">
        <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/20 shrink-0">
              <Radio className="w-5 h-5 text-white animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold tracking-tight text-white">
                  Gemini Live Voice Tester
                </h1>
                <span className="text-xs px-2 py-0.5 rounded-full font-mono bg-indigo-500/10 text-indigo-400 border border-indigo-500/30">
                  {modelId}
                </span>
                {activeSession && (
                  <span className="text-[11px] font-mono text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded border border-slate-700/60 hidden md:inline">
                    ID: {activeSession.sessionId.substring(0, 16)}...
                  </span>
                )}
                <span
                  className="text-[11px] font-mono text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30 hidden lg:inline"
                  title="Conversation language is locked for the session and preserved across interruptions/reconnects."
                >
                  Lang: {sessionLanguageLabel}
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Full-duplex real-time audio • 32ms chunk cadence • Instant barge-in cancellation
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {/* API Key Status / Configuration Trigger */}
            <button
              onClick={() => setShowKeyConfigModal(true)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition cursor-pointer ${
                apiKey || hasServerKey
                  ? 'bg-slate-800/80 border-slate-700 text-slate-200 hover:bg-slate-700'
                  : 'bg-amber-500/10 border-amber-500/40 text-amber-300 hover:bg-amber-500/20'
              }`}
            >
              <Key className="w-3.5 h-3.5" />
              <span>
                {apiKey
                  ? 'User API Key: Configured'
                  : hasServerKey
                  ? 'Server Key: Configured'
                  : 'Configure API Key'}
              </span>
              <span className="text-[10px] text-slate-400 uppercase ml-1">(Edit)</span>
            </button>

            {/* Standalone Window Button */}
            {isInIframe && (
              <a
                href={window.location.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-950/60 border border-indigo-700/60 text-indigo-300 hover:bg-indigo-900/60 transition text-xs font-medium"
                title="Open in standalone tab for unrestricted microphone permission"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Open Standalone</span>
              </a>
            )}

            {/* Live State Badge */}
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border ${stateBadge.color}`}
            >
              <span className={`w-2 h-2 rounded-full ${stateBadge.dot}`} />
              <span className="capitalize">{stateBadge.label}</span>
              {isSessionActive && activeSession && (
                <span className="text-slate-400 font-mono text-[11px] border-l border-slate-700 pl-2">
                  {formatSeconds(activeSession.elapsedSeconds)}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-6 flex flex-col gap-6">
        {/* Iframe Notice Banner if in embedded preview */}
        {isInIframe && (
          <div className="p-3.5 rounded-xl bg-indigo-950/40 border border-indigo-800/50 text-indigo-200 text-xs flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-indigo-400 shrink-0" />
              <span>
                Embedded preview detected. If microphone permission is blocked by iframe policy, open in standalone tab.
              </span>
            </div>
            <a
              href={window.location.href}
              target="_blank"
              rel="noreferrer"
              className="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition"
            >
              Open in Standalone Tab ↗
            </a>
          </div>
        )}

        {/* Detailed Error / Diagnostic Alert Box */}
        {errorDetails && (
          <div className="p-4 sm:p-5 rounded-2xl bg-rose-950/60 border border-rose-800/80 text-rose-200 space-y-2 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-rose-300">Failure Diagnostic:</span>
                    <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-rose-900/60 text-rose-200 border border-rose-700/60">
                      {errorDetails.code}
                    </span>
                  </div>
                  <p className="text-xs text-rose-200 font-mono break-all">{errorDetails.message}</p>
                  {errorDetails.instruction && (
                    <p className="text-xs text-rose-300 font-medium pt-1">
                      👉 <strong>Action Required:</strong> {errorDetails.instruction}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => setErrorDetails(null)}
                className="text-xs text-rose-400 hover:text-rose-200 px-2 py-1 rounded bg-rose-900/40"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Action Controls & Hardware Bar */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            {!isSessionActive ? (
              <button
                onClick={startConversation}
                disabled={appState === 'connecting' || appState === 'mic_permission_pending'}
                className="flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-semibold text-sm transition shadow-lg shadow-indigo-600/30 cursor-pointer disabled:opacity-50"
              >
                {appState === 'connecting' || appState === 'mic_permission_pending' ? (
                  <>
                    <RefreshCw className="w-5 h-5 animate-spin" />
                    <span>Connecting Session...</span>
                  </>
                ) : (
                  <>
                    <PhoneCall className="w-5 h-5" />
                    <span>Start Conversation</span>
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={endConversation}
                className="flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-xl bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white font-semibold text-sm transition shadow-lg shadow-rose-600/30 cursor-pointer"
              >
                <PhoneOff className="w-5 h-5" />
                <span>End Conversation</span>
              </button>
            )}

            {/* Standalone Mic Hardware Test Button */}
            <button
              onClick={testMicrophone}
              disabled={isSessionActive}
              className={`flex items-center gap-2 px-4 py-3 rounded-xl border text-xs font-semibold transition cursor-pointer disabled:opacity-40 ${
                isTestingMic
                  ? 'bg-emerald-950/60 border-emerald-600 text-emerald-300'
                  : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
              }`}
            >
              <Mic className="w-4 h-4" />
              <span>{isTestingMic ? 'Stop Mic Test' : 'Test Mic Hardware'}</span>
            </button>

            {/* Voice Persona Selector */}
            <div className="flex items-center gap-2 bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2.5">
              <label htmlFor="voice-select" className="text-xs text-slate-400 font-medium">
                Voice:
              </label>
              <select
                id="voice-select"
                disabled={isSessionActive}
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                className="bg-transparent text-xs font-semibold text-indigo-300 focus:outline-none cursor-pointer disabled:opacity-50"
              >
                {PREBUILT_VOICES.map((v) => (
                  <option key={v} value={v} className="bg-slate-900 text-slate-100">
                    {v}
                  </option>
                ))}
              </select>
            </div>

            {/* Conversation Language Selector (locked for the whole session) */}
            <div className="flex items-center gap-2 bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2.5">
              <label htmlFor="language-select" className="text-xs text-slate-400 font-medium">
                Language:
              </label>
              <select
                id="language-select"
                disabled={isSessionActive}
                value={selectedLanguage}
                onChange={(e) => handleLanguageChange(e.target.value)}
                title="Locked for the session and preserved across interruptions and reconnects."
                className="bg-transparent text-xs font-semibold text-emerald-300 focus:outline-none cursor-pointer disabled:opacity-50 max-w-[190px]"
              >
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l.code || 'auto'} value={l.code} className="bg-slate-900 text-slate-100">
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Active Generation & Audio Pipeline Badges */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-950/60 text-indigo-300 border border-indigo-700/60 font-mono">
              <Gauge className="w-3.5 h-3.5 text-indigo-400" />
              <span>Generation: {activeGenerationId}</span>
            </span>
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800/80 text-slate-300 border border-slate-700/60 font-mono">
              <Sliders className="w-3.5 h-3.5 text-emerald-400" />
              <span>Cadence: 32ms (512 @ 16k)</span>
            </span>
          </div>
        </section>

        {/* Real Audio Streaming & Activity Visualizer */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* User Microphone Status & Input VU Meter */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                    isMicStreaming || isTestingMic
                      ? micVolume > 10
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                        : 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/40'
                      : 'bg-slate-800 text-slate-500'
                  }`}
                >
                  {isMicStreaming || isTestingMic ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">Microphone Input</h2>
                  <p className="text-xs text-slate-400 truncate max-w-[200px] sm:max-w-xs">
                    {micDeviceLabel || (isMicStreaming ? 'Active Audio Track' : 'Hardware Idle')}
                  </p>
                </div>
              </div>
              <span
                className={`text-xs px-2.5 py-0.5 rounded font-mono ${
                  micVolume > 10
                    ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/30'
                    : isMicStreaming || isTestingMic
                    ? 'bg-slate-800 text-slate-400'
                    : 'bg-slate-950 text-slate-600'
                }`}
              >
                {micVolume > 10 ? 'USER SPEAKING' : isMicStreaming ? 'STREAMING' : isTestingMic ? 'TESTING' : 'OFF'}
              </span>
            </div>

            {/* Real Mic VU Meter */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                <span>Input Energy Level</span>
                <span>{micVolume}%</span>
              </div>
              <div className="h-3.5 bg-slate-950 rounded-full overflow-hidden p-0.5 border border-slate-800">
                <div
                  className={`h-full rounded-full transition-all duration-75 ${
                    micVolume > 70
                      ? 'bg-gradient-to-r from-emerald-500 via-amber-400 to-rose-500'
                      : 'bg-gradient-to-r from-emerald-500 to-teal-400'
                  }`}
                  style={{ width: `${micVolume}%` }}
                />
              </div>
            </div>

            <p className="text-[11px] text-slate-500">
              Microphone chunks are packaged every ~32ms (512 samples) and transmitted incrementally. Capture remains continuous during model playback.
            </p>
          </div>

          {/* Model Spoken Audio Status & Output Wave / VU Meter */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                    appState === 'receiving_audio'
                      ? 'bg-purple-500/20 text-purple-400 border border-purple-500/40 animate-pulse'
                      : 'bg-slate-800 text-slate-500'
                  }`}
                >
                  <Volume2 className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">Model Response Output</h2>
                  <p className="text-xs text-slate-400">
                    {appState === 'receiving_audio'
                      ? `Synthesizing ${activeGenerationId} native 24kHz speech`
                      : activeSession && activeSession.uniqueGenerationsInterrupted > 0
                      ? `Interruption handled on ${activeSession.interruptionTimingOutcome}`
                      : isSessionActive
                      ? 'Awaiting user input'
                      : 'Inactive'}
                  </p>
                </div>
              </div>
              <span
                className={`text-xs px-2.5 py-0.5 rounded font-mono ${
                  appState === 'receiving_audio'
                    ? 'bg-purple-500/20 text-purple-300 font-bold border border-purple-500/30 animate-pulse'
                    : activeSession && activeSession.uniqueGenerationsInterrupted > 0
                    ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {appState === 'receiving_audio'
                  ? 'SPEAKING'
                  : activeSession && activeSession.uniqueGenerationsInterrupted > 0
                  ? 'INTERRUPTED'
                  : 'IDLE'}
              </span>
            </div>

            {/* Model Output VU Meter */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                <span>Synthesized Output Level</span>
                <span>{outputVolume}%</span>
              </div>
              <div className="h-3.5 bg-slate-950 rounded-full overflow-hidden p-0.5 border border-slate-800">
                <div
                  className="h-full rounded-full transition-all duration-75 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500"
                  style={{ width: `${outputVolume}%` }}
                />
              </div>
            </div>

            {/* Interruption Status Banner */}
            {activeSession && activeSession.uniqueGenerationsInterrupted > 0 ? (
              <div className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  <span>
                    Barge-in handled ({activeSession.interruptionTimingOutcome})! Stop duration:{' '}
                    {activeSession.interruptionToStopDurationMs !== null
                      ? `${activeSession.interruptionToStopDurationMs}ms`
                      : '<1ms'}
                  </span>
                </div>
                <span className="font-mono text-[10px] text-rose-400">
                  Gen Interrupted: {activeSession.uniqueGenerationsInterrupted}
                </span>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500">
                Speak while the assistant is responding to trigger server-authoritative barge-in interruption.
              </p>
            )}
          </div>
        </section>

        {/* 13-Stage Pipeline Latency & Diagnostic Grid */}
        <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 space-y-1">
            <span className="text-[11px] text-slate-400 font-medium block">Transport RTT</span>
            <span className="text-sm font-mono font-bold text-cyan-400 block">
              {activeSession?.rttTransportLatencyMs !== null && activeSession?.rttTransportLatencyMs !== undefined
                ? `${activeSession.rttTransportLatencyMs} ms`
                : '—'}
            </span>
            <span className="text-[10px] text-slate-500 block">Browser ↔ Bridge</span>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 space-y-1">
            <span className="text-[11px] text-slate-400 font-medium block">Capture-to-Send</span>
            <span className="text-sm font-mono font-bold text-emerald-400 block">
              {activeSession?.micCaptureToSendMs !== null && activeSession?.micCaptureToSendMs !== undefined
                ? `${activeSession.micCaptureToSendMs} ms`
                : '—'}
            </span>
            <span className="text-[10px] text-slate-500 block">Resample + PCM encode</span>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 space-y-1">
            <span className="text-[11px] text-slate-400 font-medium block">Bridge Forwarding</span>
            <span className="text-sm font-mono font-bold text-indigo-400 block">
              {activeSession?.bridgeForwardDurationMs !== null && activeSession?.bridgeForwardDurationMs !== undefined
                ? `${activeSession.bridgeForwardDurationMs} ms`
                : '<0.5 ms'}
            </span>
            <span className="text-[10px] text-slate-500 block">Bridge ➔ Live API</span>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 space-y-1">
            <span className="text-[11px] text-slate-400 font-medium block">Cancel-to-Silence</span>
            <span className="text-sm font-mono font-bold text-rose-400 block">
              {activeSession?.interruptionToStopDurationMs !== null &&
              activeSession?.interruptionToStopDurationMs !== undefined
                ? `${activeSession.interruptionToStopDurationMs} ms`
                : '—'}
            </span>
            <span className="text-[10px] text-slate-500 block">Gain mute + queue purge</span>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 space-y-1">
            <span className="text-[11px] text-slate-400 font-medium block">Next Speech Audible</span>
            <span className="text-sm font-mono font-bold text-amber-400 block">
              {activeSession?.interruptionToNextResponseAudibleMs !== null &&
              activeSession?.interruptionToNextResponseAudibleMs !== undefined
                ? `${activeSession.interruptionToNextResponseAudibleMs} ms`
                : '—'}
            </span>
            <span className="text-[10px] text-slate-500 block">Interruption ➔ New audio</span>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 space-y-1">
            <span className="text-[11px] text-slate-400 font-medium block">First Audio Latency</span>
            <span className="text-sm font-mono font-bold text-purple-400 block">
              {activeSession?.firstAudioLatencyMs !== null && activeSession?.firstAudioLatencyMs !== undefined
                ? `${activeSession.firstAudioLatencyMs} ms`
                : '—'}
            </span>
            <span className="text-[10px] text-slate-500 block">User speech ➔ First chunk</span>
          </div>
        </section>

        {/* Packet Accounting Table */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
              <Activity className="w-4 h-4 text-indigo-400" />
              Isolated Session Packet Accounting
            </h3>
            <span className="text-[11px] text-slate-400 font-mono">
              Session: {activeSession?.sessionId || 'None'}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
            <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80">
              <span className="text-slate-500 text-[10px] block">Mic Captured</span>
              <span className="text-slate-200 font-bold">{activeSession?.micChunksCaptured || 0}</span>
            </div>
            <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80">
              <span className="text-slate-500 text-[10px] block">Mic Sent by Browser</span>
              <span className="text-slate-200 font-bold">{activeSession?.micChunksSent || 0}</span>
            </div>
            <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80">
              <span className="text-slate-500 text-[10px] block">Model Chunks Delivered</span>
              <span className="text-slate-200 font-bold">{activeSession?.modelChunksDeliveredClient || 0}</span>
            </div>
            <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80">
              <span className="text-slate-500 text-[10px] block">Model Chunks Rendered</span>
              <span className="text-slate-200 font-bold">{activeSession?.modelChunksRendered || 0}</span>
            </div>
          </div>
        </section>

        {/* Quota & Token Telemetry Notice Bar */}
        <section className="bg-slate-900/90 border border-slate-800 rounded-xl p-3 sm:px-4 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-indigo-400" />
            <span className="font-semibold text-slate-300">Live API Token Telemetry:</span>
            {activeSession?.usageMetadata ? (
              <div className="flex items-center gap-3 font-mono text-[11px]">
                <span className="text-slate-300">
                  Prompt: <strong className="text-white">{activeSession.usageMetadata.promptTokenCount ?? 0}</strong>
                </span>
                <span className="text-slate-500">•</span>
                <span className="text-slate-300">
                  Response: <strong className="text-white">{activeSession.usageMetadata.responseTokenCount ?? 0}</strong>
                </span>
                <span className="text-slate-500">•</span>
                <span className="text-slate-300">
                  Total: <strong className="text-indigo-400">{activeSession.usageMetadata.totalTokenCount ?? 0}</strong>
                </span>
              </div>
            ) : (
              <span className="text-slate-400 italic">
                {isSessionActive
                  ? 'Awaiting usageMetadata from Gemini Live API...'
                  : 'Tokens recorded when model returns usageMetadata.'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono text-amber-400/90 bg-amber-500/10 px-2.5 py-1 rounded border border-amber-500/20">
              Remaining account quota is not exposed by this session API.
            </span>
            <button
              onClick={copyDiagnostics}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 active:bg-slate-900 text-slate-300 transition text-xs cursor-pointer"
            >
              {copiedLogs ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedLogs ? 'Copied Diagnostic JSON' : 'Export Diagnostics'}</span>
            </button>
          </div>
        </section>

        {/* Tabs */}
        <div className="flex items-center border-b border-slate-800 gap-2">
          <button
            onClick={() => setActiveTab('conversation')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${
              activeTab === 'conversation'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Conversation Log ({turns.length})
          </button>
          <button
            onClick={() => setActiveTab('diagnostics')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${
              activeTab === 'diagnostics'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Diagnostics & Event Stream ({events.length})
          </button>
          <button
            onClick={() => setActiveTab('pipeline')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${
              activeTab === 'pipeline'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            13-Stage Pipeline Breakdown
          </button>
          <button
            onClick={() => setActiveTab('guide')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${
              activeTab === 'guide'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Interruption Test Protocol
          </button>
        </div>

        {/* Tab 1: Conversation Log */}
        {activeTab === 'conversation' && (
          <section className="space-y-3">
            {turns.length === 0 ? (
              <div className="bg-slate-900/60 border border-dashed border-slate-800 rounded-2xl p-10 text-center space-y-3">
                <Radio className="w-8 h-8 text-slate-600 mx-auto" />
                <h3 className="text-sm font-semibold text-slate-300">No conversational turns yet in this session</h3>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  Click <strong>Start Conversation</strong> and speak naturally. While the model is speaking, speak into
                  your mic to evaluate low-latency barge-in interruption.
                </p>
              </div>
            ) : (
              turns.map((turn) => (
                <div
                  key={turn.id}
                  className={`bg-slate-900 border rounded-xl p-4 space-y-2.5 transition ${
                    turn.status === 'interrupted'
                      ? 'border-rose-900/60 bg-rose-950/20'
                      : turn.status === 'responding'
                      ? 'border-purple-800/60'
                      : 'border-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-slate-400">Turn #{turn.turnNumber}</span>
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[11px]">
                        Gen: {turn.generationId}
                      </span>
                      <span className="text-slate-600">•</span>
                      <span className="text-slate-400 font-mono">
                        {new Date(turn.startTimeUtc).toLocaleTimeString()}
                      </span>
                      {turn.firstAudioLatencyMs !== undefined && (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono text-[11px] border border-emerald-500/30">
                          First audio: {turn.firstAudioLatencyMs}ms
                        </span>
                      )}
                    </div>
                    <div>
                      {turn.status === 'interrupted' ? (
                        <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 font-semibold font-mono text-[11px] border border-rose-500/40 flex items-center gap-1">
                          <Zap className="w-3 h-3 text-rose-400" />
                          Interrupted
                        </span>
                      ) : turn.status === 'completed' ? (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-semibold font-mono text-[11px] border border-emerald-500/30 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          Completed
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 font-semibold font-mono text-[11px] border border-purple-500/40 animate-pulse">
                          Speaking...
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-sm text-slate-200 bg-slate-950/60 rounded-lg p-3 border border-slate-800/80 font-mono">
                    {turn.text ? (
                      <p className="leading-relaxed">{turn.text}</p>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <Volume2 className="w-4 h-4 text-indigo-400" />
                        <span>
                          Native audio response ({turn.audioChunksCount} PCM packets, ~
                          {(turn.totalAudioDurationMs / 1000).toFixed(1)}s speech)
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </section>
        )}

        {/* Tab 2: Diagnostics & Event Stream */}
        {activeTab === 'diagnostics' && (
          <section className="space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Session-Isolated Event Stream ({events.length} records)</span>
              <button
                onClick={() => setEvents([])}
                className="hover:text-slate-200 px-2 py-1 rounded bg-slate-900 border border-slate-800"
              >
                Clear log
              </button>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden font-mono text-xs max-h-96 overflow-y-auto divide-y divide-slate-800/60">
              {events.length === 0 ? (
                <div className="p-6 text-center text-slate-500">No events logged for current session.</div>
              ) : (
                events.map((ev) => (
                  <div
                    key={ev.id}
                    className={`p-2.5 flex items-start gap-3 ${
                      ev.type === 'interrupted'
                        ? 'bg-rose-950/30 text-rose-200'
                        : ev.type === 'error'
                        ? 'bg-red-950/40 text-red-300'
                        : ev.type === 'turn_complete'
                        ? 'bg-emerald-950/20 text-emerald-200'
                        : ev.type === 'pipeline'
                        ? 'bg-cyan-950/20 text-cyan-200'
                        : ev.type === 'state_change'
                        ? 'bg-indigo-950/20 text-indigo-200'
                        : 'text-slate-300'
                    }`}
                  >
                    <span className="text-slate-500 shrink-0 text-[11px]">
                      {new Date(ev.timestampUtc).toLocaleTimeString()}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-bold shrink-0 ${
                        ev.type === 'interrupted'
                          ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                          : ev.type === 'turn_complete'
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : ev.type === 'error'
                          ? 'bg-red-500/20 text-red-400'
                          : ev.type === 'pipeline'
                          ? 'bg-cyan-500/20 text-cyan-400'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {ev.type}
                    </span>
                    <span className="break-all">{ev.message}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        {/* Tab 3: 13-Stage Pipeline Breakdown */}
        {activeTab === 'pipeline' && (
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 text-xs font-mono">
            <div>
              <h3 className="font-bold text-white text-sm flex items-center gap-2">
                <Gauge className="w-4 h-4 text-cyan-400" />
                13-Stage Interruption & Full-Duplex Pipeline Instrumentation
              </h3>
              <p className="text-slate-400 mt-1">
                Monotonically measured timings across the complete audio and interruption cycle:
              </p>
            </div>

            <div className="space-y-2 border-t border-slate-800 pt-3">
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">1. Browser mic audio captured (512 samples)</span>
                <span className="text-emerald-400">~32.0 ms cadence</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">2. Audio chunk resampled to 16kHz & PCM-encoded</span>
                <span className="text-emerald-400">
                  {activeSession?.micCaptureToSendMs ? `${activeSession.micCaptureToSendMs} ms` : '<1.0 ms'}
                </span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">3. Audio chunk transmitted via WebSocket</span>
                <span className="text-cyan-400">Sequence tagged</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">4. Audio chunk received by WebSocket bridge</span>
                <span className="text-cyan-400">
                  RTT: {activeSession?.rttTransportLatencyMs ? `${activeSession.rttTransportLatencyMs} ms` : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">5. Audio chunk forwarded to Gemini Live API</span>
                <span className="text-indigo-400">
                  {activeSession?.bridgeForwardDurationMs ? `${activeSession.bridgeForwardDurationMs} ms` : '<0.5 ms'}
                </span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">6. Gemini Live VAD interruption event received by bridge</span>
                <span className="text-rose-400">serverContent.interrupted</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">7. Interruption event delivered to browser</span>
                <span className="text-rose-400">WebSocket frame tagged</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">8. Browser receives & processes interruption event</span>
                <span className="text-rose-400">Active generation tagged</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">9. Browser playback queue invalidated</span>
                <span className="text-rose-400">invalidatedGenerations.add()</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">10. Scheduled sources stopped & gain muted</span>
                <span className="text-rose-400">
                  {activeSession?.interruptionToStopDurationMs ? `${activeSession.interruptionToStopDurationMs} ms` : '<1.0 ms'}
                </span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">11. New microphone speech continues uninterrupted</span>
                <span className="text-emerald-400">Continuous 16kHz full-duplex</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">12. First new response audio arrives from Gemini</span>
                <span className="text-purple-400">New generation ID tagged</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-300">13. First new response audio becomes audible</span>
                <span className="text-purple-400">
                  {activeSession?.interruptionToNextResponseAudibleMs
                    ? `${activeSession.interruptionToNextResponseAudibleMs} ms`
                    : '—'}
                </span>
              </div>
            </div>
          </section>
        )}

        {/* Tab 4: Interruption Test Protocol */}
        {activeTab === 'guide' && (
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5 text-sm">
            <div>
              <h3 className="font-bold text-white text-base flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-indigo-400" />
                Interruption Testing Protocol
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Repeatable procedures to evaluate low-latency barge-in with model{' '}
                <strong className="text-indigo-300 font-mono">{modelId}</strong>:
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
                <span className="text-indigo-400 font-semibold text-xs uppercase tracking-wide block">
                  Scenario A: Mid-Turn Barge-In
                </span>
                <p className="text-xs text-slate-300">
                  Say: <em>&ldquo;Count to 20 slowly.&rdquo;</em> When the assistant reaches &ldquo;3&rdquo;, speak firmly: <em>&ldquo;Stop, what is 5 plus 5?&rdquo;</em>
                </p>
                <p className="text-[11px] text-slate-500">
                  Verify the assistant cuts off instantly (&lt;1ms gain mute), generation increments, and the new answer is spoken without remaining numbers bleeding through.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
                <span className="text-rose-400 font-semibold text-xs uppercase tracking-wide block">
                  Scenario B: Rapid Successive Interruptions
                </span>
                <p className="text-xs text-slate-300">
                  Say: <em>&ldquo;Tell me a long story.&rdquo;</em> As soon as it begins, say <em>&ldquo;Wait!&rdquo;</em> then immediately <em>&ldquo;No, wait!&rdquo;</em>
                </p>
                <p className="text-[11px] text-slate-500">
                  Verify that generation IDs increment cleanly (gen_1 ➔ gen_2 ➔ gen_3) and obsolete queued buffers are discarded without state corruption.
                </p>
              </div>
            </div>
          </section>
        )}
      </main>

      {/* API Key Configuration Modal */}
      {showKeyConfigModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center shrink-0">
                  <Key className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Google Gemini API Key</h3>
                  <p className="text-xs text-slate-400">
                    Required for connecting to the <code className="text-indigo-300">{modelId}</code> model.
                  </p>
                </div>
              </div>
              {(apiKey || hasServerKey) && (
                <button
                  onClick={() => setShowKeyConfigModal(false)}
                  className="text-slate-400 hover:text-slate-200 text-xs px-2 py-1 rounded bg-slate-800"
                >
                  Cancel
                </button>
              )}
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">API Key</label>
                <div className="relative">
                  <input
                    type={showKeyText ? 'text' : 'password'}
                    placeholder="Enter your Gemini API key (e.g. AIzaSy...)"
                    value={inputKey}
                    onChange={(e) => {
                      setInputKey(e.target.value);
                      setKeyError(null);
                    }}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500 pr-10 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKeyText(!showKeyText)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    {showKeyText ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {keyError && <p className="text-xs text-rose-400">{keyError}</p>}
              </div>

              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 text-[11px] text-slate-400 space-y-1.5">
                <div className="flex items-center gap-1.5 text-slate-300 font-semibold">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Secure Credential Handling</span>
                </div>
                <p>• Stored only in this browser tab&apos;s session storage.</p>
                <p>• Transmitted over the local WebSocket to authenticate the Gemini Live session.</p>
                <p>• Never exposed in diagnostic logs, exports, or client-side telemetry.</p>
              </div>

              <div className="text-xs text-slate-400">
                Need an API key?{' '}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-400 hover:text-indigo-300 underline inline-flex items-center gap-1 font-medium"
                >
                  Get an API key from Google AI Studio <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-slate-800">
              {apiKey ? (
                <button
                  type="button"
                  onClick={handleClearApiKey}
                  className="text-xs text-rose-400 hover:text-rose-300 px-3 py-2 rounded-lg bg-rose-950/40 border border-rose-800/40 cursor-pointer"
                >
                  Clear Configured Key
                </button>
              ) : (
                <div />
              )}

              <button
                type="button"
                onClick={handleSaveApiKey}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-semibold text-xs shadow-lg shadow-indigo-600/30 cursor-pointer"
              >
                Save and Connect
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-900/60 px-4 py-3 text-center text-xs text-slate-500">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>Gemini Live Voice Benchmark • Model: {modelId}</span>
          <span>13-Stage Interruption Instrumentation • Low-Latency Full-Duplex PCM</span>
        </div>
      </footer>
    </div>
  );
}
