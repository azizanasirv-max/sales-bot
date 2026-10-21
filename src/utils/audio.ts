/**
 * Audio processing utilities for Gemini Live API
 * Mic input format: 16kHz, mono, 16-bit linear PCM (LE)
 * Model output format: 24kHz, mono, 16-bit linear PCM (LE)
 */

/**
 * Linearly resamples a Float32Array from inputSampleRate to targetSampleRate (e.g. 16000)
 */
export function resampleTo16k(input: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === 16000) return input;
  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(input.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const origIndex = i * ratio;
    const indexLow = Math.floor(origIndex);
    const indexHigh = Math.min(indexLow + 1, input.length - 1);
    const weight = origIndex - indexLow;
    result[i] = input[indexLow] * (1 - weight) + input[indexHigh] * weight;
  }
  return result;
}

/**
 * Converts Float32 [-1.0, 1.0] samples to 16-bit signed PCM (little-endian Uint8Array)
 */
export function floatTo16BitPCM(input: Float32Array): Uint8Array {
  const output = new Uint8Array(input.length * 2);
  const view = new DataView(output.buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(i * 2, int16, true);
  }
  return output;
}

/**
 * Encodes a Uint8Array to base64 string
 */
export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decodes base64 string to Float32Array from 16-bit PCM
 */
export function base64PCMToFloat32(base64: string): Float32Array {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const numSamples = Math.floor(bytes.length / 2);
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const int16 = view.getInt16(i * 2, true);
    float32[i] = int16 / 32768.0;
  }
  return float32;
}

/**
 * Calculates RMS volume (0.0 to 1.0)
 */
export function calculateRMS(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}
