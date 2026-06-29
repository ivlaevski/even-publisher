import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';

import type { PublisherTopic } from './types';

const STATUS_ID = 'status';
const LOG_ID = 'event-log';

async function getStorageValue(bridge: EvenAppBridge | null, key: string): Promise<string> {
  if (bridge) return (await bridge.getLocalStorage(key)) ?? '';
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

async function setStorageValue(bridge: EvenAppBridge | null, key: string, value: string): Promise<void> {
  if (bridge) {
    await bridge.setLocalStorage(key, value);
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore storage errors */
  }
}

export function setStatus(message: string): void {
  // eslint-disable-next-line no-console
  console.log('[article-publisher:status]', message);
  const el = document.getElementById(STATUS_ID);
  if (el) {
    el.textContent = message;
  }
}

export function appendEventLog(message: string): void {
  // eslint-disable-next-line no-console
  console.log('[article-publisher:log]', message);
  const el = document.getElementById(LOG_ID);
  if (!el) return;
  const now = new Date();
  const ts = now.toISOString().split('T')[1]?.replace('Z', '') ?? '';
  el.textContent = `[${ts}] ${message}\n` + el.textContent;
}

let globalErrorLoggingInstalled = false;

function formatConsoleArgs(parts: unknown[]): string {
  return parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p instanceof Error) return p.stack ?? p.message;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(' ');
}

/** Routes uncaught errors, unhandled rejections, and console.error into the event log UI. */
export function installGlobalErrorLogging(): void {
  if (globalErrorLoggingInstalled) return;
  globalErrorLoggingInstalled = true;

  window.addEventListener(
    'error',
    (ev: ErrorEvent) => {
      const loc =
        ev.filename && ev.lineno
          ? ` (${ev.filename}:${ev.lineno}:${ev.colno ?? 0})`
          : '';
      const detail =
        ev.error instanceof Error ? ev.error.stack ?? ev.error.message : ev.message || 'Unknown error';
      appendEventLog(`[window.error]${loc} ${detail}`);
    },
    true,
  );

  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const r = ev.reason;
    const detail = r instanceof Error ? r.stack ?? r.message : String(r);
    appendEventLog(`[unhandledrejection] ${detail}`);
  });

  const origError = console.error.bind(console);
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => {
    origError(...args);
    appendEventLog(`[console.error] ${formatConsoleArgs(args)}`);
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise
      .then((value) => resolve(value))
      .catch((error) => reject(error))
      .finally(() => window.clearTimeout(timer));
  });
}

export async function loadConfigFromLocalStorage(bridge: EvenAppBridge | null): Promise<{
  googleGenerativeApiKey: string;
  googleGenerativeDraftModel: string;
  wordpressBaseUrl: string;
  wordpressUsername: string;
  wordpressPassword: string;
  elevenLabsApiKey: string;
}> {
  const [
    googleGenerativeApiKey,
    googleGenerativeDraftModel,
    wordpressBaseUrl,
    wordpressUsername,
    wordpressPassword,
    elevenLabsApiKey,
  ] = await Promise.all([
    getStorageValue(bridge, 'article-publisher:google-generative-key'),
    getStorageValue(bridge, 'article-publisher:google-generative-draft-model'),
    getStorageValue(bridge, 'article-publisher:wp-url'),
    getStorageValue(bridge, 'article-publisher:wp-username'),
    getStorageValue(bridge, 'article-publisher:wp-password'),
    getStorageValue(bridge, 'article-publisher:elevenlabs-key'),
  ]);
  return {
    googleGenerativeApiKey,
    googleGenerativeDraftModel: googleGenerativeDraftModel || 'gemini-3-flash-preview',
    wordpressBaseUrl,
    wordpressUsername,
    wordpressPassword,
    elevenLabsApiKey,
  };
}

export async function saveConfigToLocalStorage(
  bridge: EvenAppBridge | null,
  config: {
  googleGenerativeApiKey: string;
  googleGenerativeDraftModel: string;
  wordpressBaseUrl: string;
  wordpressUsername: string;
  wordpressPassword: string;
  elevenLabsApiKey: string;
},
): Promise<void> {
  await Promise.all([
    setStorageValue(bridge, 'article-publisher:google-generative-key', config.googleGenerativeApiKey.trim()),
    setStorageValue(
      bridge,
      'article-publisher:google-generative-draft-model',
      config.googleGenerativeDraftModel.trim(),
    ),
    setStorageValue(bridge, 'article-publisher:wp-url', config.wordpressBaseUrl.trim()),
    setStorageValue(bridge, 'article-publisher:wp-username', config.wordpressUsername.trim()),
    setStorageValue(bridge, 'article-publisher:wp-password', config.wordpressPassword.trim()),
    setStorageValue(bridge, 'article-publisher:elevenlabs-key', config.elevenLabsApiKey.trim()),
  ]);
}

export async function loadTopicsFromLocalStorage(bridge: EvenAppBridge | null): Promise<PublisherTopic[]> {
  const raw = await getStorageValue(bridge, 'article-publisher:topics');
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((entry) => normalizePublisherTopic(entry))
        .filter((topic) => topic.name.length > 0);
    } catch {
      appendEventLog('Failed to parse topics JSON; falling back to legacy format.');
    }
  }

  return trimmed
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((name) => ({ name, rssUrl: '' }));
}

function normalizePublisherTopic(entry: unknown): PublisherTopic {
  if (typeof entry === 'string') {
    return { name: entry.trim(), rssUrl: '' };
  }
  if (entry && typeof entry === 'object') {
    const record = entry as { name?: unknown; rssUrl?: unknown };
    return {
      name: String(record.name ?? '').trim(),
      rssUrl: String(record.rssUrl ?? '').trim(),
    };
  }
  return { name: '', rssUrl: '' };
}

export async function saveTopicsToLocalStorage(
  bridge: EvenAppBridge | null,
  topics: PublisherTopic[],
): Promise<void> {
  const normalized = topics
    .map((topic) => ({
      name: topic.name.trim(),
      rssUrl: topic.rssUrl.trim(),
    }))
    .filter((topic) => topic.name.length > 0);
  await setStorageValue(bridge, 'article-publisher:topics', JSON.stringify(normalized));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

