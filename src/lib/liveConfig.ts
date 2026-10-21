/**
 * Live session configuration and startup validation.
 *
 * Kept separate from server.ts so the policy can be unit-tested without
 * opening a WebSocket or contacting Google's API.
 */

import { Modality, type LiveConnectConfig } from '@google/genai';
import { composeSystemInstruction, type LanguagePreference } from './conversation';

export const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';

/**
 * Normalizes the server-side key. AI Studio injects the real secret; a copied
 * `.env.example` contains the literal placeholder. The placeholder must never
 * be treated as a usable key (otherwise the UI skips its "key required" flow
 * and the bridge attempts an authenticated connection with "MY_GEMINI_API_KEY").
 */
export function resolveServerApiKey(raw?: string | null): string {
  const key = (raw || '').trim();
  if (!key || key === 'MY_GEMINI_API_KEY') return '';
  return key;
}


/**
 * Models in this family produce audio natively. Google's Live API documentation
 * states that "Native audio output models automatically choose the appropriate
 * language and don't support explicitly setting the language code." Sending
 * `speechConfig.languageCode` for these models is therefore not a supported
 * configuration; language locking relies on the system instruction instead.
 */
const NATIVE_AUDIO_MODEL_PATTERN =
  /^(?:gemini-3\.8-live(?:-extended-thinking)?|gemini-3\.1-flash-live(?:-preview)?|.*native-audio.*)$/i;

export function isNativeAudioModel(model: string): boolean {
  return NATIVE_AUDIO_MODEL_PATTERN.test(model.trim());
}

/**
 * Whether `speechConfig.languageCode` is documented as supported for a model.
 *
 * Only legacy half-cascade Live models expose this field. Unknown models are
 * treated as not supporting it, because sending an unsupported setup field is
 * worse than relying on the (always supported) system instruction.
 */
export function supportsSpeechLanguageCode(model: string): boolean {
  return /^gemini-2\..*-live(?:-|$)/i.test(model.trim()) && !isNativeAudioModel(model);
}


export const DEFAULT_SYSTEM_INSTRUCTION =
  'You are a real-time voice testing assistant. Keep your spoken responses natural, expressive, and concise (1-3 sentences) so the user can easily evaluate speech quality, latency, and barge-in interruption.';

const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The model actually used by the bridge. `GEMINI_LIVE_MODEL` allows operators
 * to follow a model rename without editing code; the built-in default is kept
 * so AI Studio deployments behave exactly as before when the variable is unset.
 */
export function resolveLiveModel(envModel?: string | null): string {
  const candidate = (envModel || '').trim();
  if (candidate && MODEL_NAME_PATTERN.test(candidate)) return candidate;
  return DEFAULT_LIVE_MODEL;
}

export interface StartRequestInput {
  model?: string;
  apiKey?: string;
}

export interface StartRequestEnvironment {
  serverApiKey: string;
  targetModel: string;
}

export type StartValidation =
  | { ok: true; model: string; apiKey: string }
  | { ok: false; code: 'INVALID_MODEL' | 'API_KEY_MISSING'; error: string };

/**
 * Validates a `start` frame before any network connection is attempted.
 *
 * The model check is deliberately strict (the previous behaviour): an unknown
 * model is rejected rather than silently substituted, because a substitution
 * would make latency/voice diagnostics meaningless. `targetModel` comes from
 * configuration, so a model rename still works without code changes.
 */
export function validateStartRequest(
  input: StartRequestInput,
  env: StartRequestEnvironment
): StartValidation {
  const requestedModel = (input.model || env.targetModel).trim();
  if (requestedModel !== env.targetModel) {
    return {
      ok: false,
      code: 'INVALID_MODEL',
      error: `Invalid model requested: "${requestedModel}". Only "${env.targetModel}" is supported.`,
    };
  }

  const userKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const effectiveApiKey = userKey || env.serverApiKey;
  if (!effectiveApiKey) {
    return {
      ok: false,
      code: 'API_KEY_MISSING',
      error:
        'No Gemini API key supplied. Please enter your Google Gemini API key in the configuration screen.',
    };
  }

  return { ok: true, model: requestedModel, apiKey: effectiveApiKey };
}

export interface LiveConfigInput {
  voice: string;
  language: LanguagePreference;
  baseSystemInstruction?: string;
  resumptionHandle?: string | null;
  /** Resolved model. Used to decide whether languageCode is supported. */
  model?: string;
  /** Explicit override for tests/advanced callers. */
  supportsLanguageCode?: boolean;
}

/**
 * Builds the Live API session config.
 *
 * Notes:
 *  - `speechConfig.languageCode` is only sent for models where Google
 *    documents support for it (legacy half-cascade Live models). Native-audio
 *    models such as `gemini-3.8-live` choose the language themselves and do not
 *    support an explicit code; for those the (always supported) system
 *    instruction is the only language lever.
 *  - `contextWindowCompression.slidingWindow` keeps long sessions (5+ minutes)
 *    from hitting the context limit.
 *  - `sessionResumption` is only given a handle when reconnecting, so a first
 *    connection never resumes an unrelated session. An empty object opts the
 *    session into `sessionResumptionUpdate` frames.
 */
export function buildLiveConfig(input: LiveConfigInput): LiveConnectConfig {
  const voiceName = (input.voice || '').trim() || 'Puck';
  const model = input.model || DEFAULT_LIVE_MODEL;
  const languageCodeSupported =
    input.supportsLanguageCode ?? supportsSpeechLanguageCode(model);

  const config: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName },
      },
    },
    systemInstruction: composeSystemInstruction(
      input.baseSystemInstruction?.trim() || DEFAULT_SYSTEM_INSTRUCTION,
      input.language
    ),
    contextWindowCompression: {
      slidingWindow: {},
    },
  };

  if (input.language.code && languageCodeSupported) {
    config.speechConfig!.languageCode = input.language.code;
  }

  if (input.resumptionHandle) {
    config.sessionResumption = { handle: input.resumptionHandle };
  } else {
    // An empty config opts the session into `sessionResumptionUpdate` frames so
    // the bridge receives a handle it can use if the transport drops.
    config.sessionResumption = {};
  }

  return config;
}

export type LiveErrorCode =
  | 'AUTH_ERROR'
  | 'QUOTA_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'MODEL_UNAVAILABLE'
  | 'SESSION_INIT_FAILED'
  | 'API_ERROR';

/** Maps raw Live API errors/close reasons to stable client-facing codes. */
export function classifyLiveError(message: string | null | undefined): LiveErrorCode {
  const text = (message || '').toLowerCase();
  if (!text) return 'API_ERROR';
  if (text.includes('api key') || text.includes('unauthenticated') || text.includes('permission denied')) {
    return 'AUTH_ERROR';
  }
  if (text.includes('resource_exhausted') || text.includes('quota')) return 'QUOTA_EXHAUSTED';
  if (text.includes('429') || text.includes('rate limit') || text.includes('too many requests')) {
    return 'RATE_LIMITED';
  }
  if (text.includes('not found') || text.includes('unsupported') || text.includes('invalid model')) {
    return 'MODEL_UNAVAILABLE';
  }
  return 'API_ERROR';
}

export type TransportCloseDecision = 'fail_initial' | 'resume' | 'close';

/**
 * Policy applied when the Gemini transport closes.
 *
 * - A connection that never became ready is a terminal initialization failure.
 * - A ready session is resumed only when the API issued a resumption handle
 *   and attempts remain; otherwise it fails closed rather than silently
 *   starting a fresh, context-less session.
 */
export function decideAfterTransportClose(input: {
  sawSessionReady: boolean;
  hasResumeHandle: boolean;
  reconnectAttempts: number;
  maxAttempts: number;
}): TransportCloseDecision {
  if (!input.sawSessionReady) return 'fail_initial';
  if (input.hasResumeHandle && input.reconnectAttempts < input.maxAttempts) return 'resume';
  return 'close';
}
