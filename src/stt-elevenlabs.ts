import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';

import { appendEventLog } from './utils';

type SttState = {
  isListening: boolean;
  audioBuffer: Uint8Array[];
  totalBytes: number;
  bridge: EvenAppBridge | null;
};

const ELEVEN_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const SAMPLE_RATE = 16000;
const MIN_AUDIO_BYTES = 3200;

export type SttLivePayload = {
  /** Estimated length of buffered PCM at 16 kHz mono 16-bit LE. */
  approxDurationMs: number;
  totalBytes: number;
};

let liveListener: ((payload: SttLivePayload) => void) | null = null;

/** Fires after each non-empty PCM chunk while recording (throttle updates in the UI). */
export function setSttLiveListener(fn: ((payload: SttLivePayload) => void) | null): void {
  liveListener = fn;
}

let state: SttState = {
  isListening: false,
  audioBuffer: [],
  totalBytes: 0,
  bridge: null,
};

export async function startSttRecording(bridge: EvenAppBridge): Promise<void> {
  if (state.isListening) return;

  if (typeof bridge.audioControl !== 'function') {
    throw new Error(
      'Microphone bridge unavailable (audioControl missing). Use the Even app on a phone with G2 connected.',
    );
  }

  state = {
    isListening: true,
    audioBuffer: [],
    totalBytes: 0,
    bridge,
  };

  const ok = await bridge.audioControl(true);
  if (!ok) {
    state.isListening = false;
    state.bridge = null;
    throw new Error(
      'Failed to open G2 microphone (audioControl returned false). Ensure g2-microphone is granted in app.json and startup UI was created.',
    );
  }
}

/**
 * PCM from G2 / phone bridge: 16 kHz, signed 16-bit little-endian, mono (2 bytes/sample).
 * Host JSON often sends `audioPcm` as number[] or base64 string (per SDK); we normalize here.
 * Chunks are buffered and wrapped as WAV in `stopSttAndTranscribe` for ElevenLabs.
 */
export function feedSttAudio(pcmData: Uint8Array | number[] | string): void {
  if (!state.isListening) return;
  const chunk = normalizePcmChunk(pcmData);
  if (chunk.length === 0) return;
  state.audioBuffer.push(chunk);
  state.totalBytes += chunk.length;
  if (liveListener) {
    liveListener({
      approxDurationMs: Math.round((state.totalBytes / 2 / SAMPLE_RATE) * 1000),
      totalBytes: state.totalBytes,
    });
  }
}

function normalizePcmChunk(pcmData: Uint8Array | number[] | string): Uint8Array {
  if (pcmData instanceof Uint8Array) return new Uint8Array(pcmData);
  if (Array.isArray(pcmData)) return new Uint8Array(pcmData);
  if (typeof pcmData === 'string') {
    let s = pcmData.trim();
    if (!s) return new Uint8Array();
    const comma = s.indexOf(',');
    if (s.startsWith('data:') && comma !== -1) {
      s = s.slice(comma + 1).trim();
    }
    try {
      const binary = atob(s);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        out[i] = binary.charCodeAt(i);
      }
      return out;
    } catch {
      return new Uint8Array();
    }
  }
  return new Uint8Array();
}

async function closeMic(): Promise<void> {
  if (state.bridge && typeof state.bridge.audioControl === 'function') {
    try {
      await state.bridge.audioControl(false);
    } catch {
      // ignore close errors
    }
  }
}

export async function stopSttAndTranscribe(apiKey: string): Promise<string> {
  if (!state.isListening) return '';

  state.isListening = false;
  await closeMic();

  if (state.audioBuffer.length === 0 || state.totalBytes < MIN_AUDIO_BYTES) {
    state.audioBuffer = [];
    state.totalBytes = 0;
    return '';
  }

  const pcmByteLength = state.totalBytes;
  const wavBlob = pcmToWav(state.audioBuffer);
  state.audioBuffer = [];
  state.totalBytes = 0;

  const durationMs = Math.round((pcmByteLength / 2 / SAMPLE_RATE) * 1000);
  // appendEventLog(
  //   `[STT] Sending audio for transcription: ${pcmByteLength} bytes PCM (~${durationMs} ms at ${SAMPLE_RATE} Hz, 16-bit LE mono) → ElevenLabs scribe_v2`,
  // );

  const formData = new FormData();
  formData.append('file', wavBlob, 'audio.wav');
  formData.append('model_id', 'scribe_v2');

  const response = await fetch(ELEVEN_STT_URL, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey.trim(),
    },
    body: formData,
  });

  if (!response.ok) {
    const errBody = await response.text();
    appendEventLog(`[STT] Transcription request failed: HTTP ${response.status} ${errBody.slice(0, 200)}`);
    throw new Error(`ElevenLabs STT error ${response.status}: ${errBody}`);
  }

  const json = (await response.json()) as any;
  const text = typeof json.text === 'string' ? json.text.trim() : '';
  const preview = text.length <= 120 ? text : `${text.slice(0, 117)}…`;
  // appendEventLog(
  //   `[STT] Transcription returned: ${text.length} character(s)${text ? ` — "${preview}"` : ' (empty)'}`,
  // );
  return text;
}

export async function cancelSttRecording(): Promise<void> {
  if (!state.isListening) return;

  state.isListening = false;
  state.audioBuffer = [];
  state.totalBytes = 0;
  await closeMic();
}

function pcmToWav(pcmChunks: Uint8Array[]): Blob {
  let totalLength = 0;
  for (const chunk of pcmChunks) {
    totalLength += chunk.length;
  }

  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + totalLength, true);
  writeString(view, 8, 'WAVE');

  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  writeString(view, 36, 'data');
  view.setUint32(40, totalLength, true);

  const parts: BlobPart[] = [header, ...pcmChunks.map((c) => c.buffer as ArrayBuffer)];
  return new Blob(parts, { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

