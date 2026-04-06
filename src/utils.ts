const STATUS_ID = 'status';
const LOG_ID = 'event-log';

export function setStatus(message: string): void {
  // eslint-disable-next-line no-console
  console.log('[even-publisher:status]', message);
  const el = document.getElementById(STATUS_ID);
  if (el) {
    el.textContent = message;
  }
}

export function appendEventLog(message: string): void {
  // eslint-disable-next-line no-console
  console.log('[even-publisher:log]', message);
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

export function loadConfigFromLocalStorage(): {
  openAiApiKey: string;
  openAiModel: string;
  wordpressBaseUrl: string;
  wordpressUsername: string;
  wordpressPassword: string;
  elevenLabsApiKey: string;
} {
  return {
    openAiApiKey: localStorage.getItem('even-publisher:openai-key') ?? '',
    openAiModel: localStorage.getItem('even-publisher:openai-model') ?? 'gpt-4.1-mini',
    wordpressBaseUrl: localStorage.getItem('even-publisher:wp-url') ?? '',
    wordpressUsername: localStorage.getItem('even-publisher:wp-username') ?? '',
    wordpressPassword: localStorage.getItem('even-publisher:wp-password') ?? '',
    elevenLabsApiKey: localStorage.getItem('even-publisher:elevenlabs-key') ?? '',
  };
}

export function saveConfigToLocalStorage(config: {
  openAiApiKey: string;
  openAiModel: string;
  wordpressBaseUrl: string;
  wordpressUsername: string;
  wordpressPassword: string;
  elevenLabsApiKey: string;
}): void {
  localStorage.setItem('even-publisher:openai-key', config.openAiApiKey.trim());
  localStorage.setItem('even-publisher:openai-model', config.openAiModel.trim());
  localStorage.setItem('even-publisher:wp-url', config.wordpressBaseUrl.trim());
  localStorage.setItem('even-publisher:wp-username', config.wordpressUsername.trim());
  localStorage.setItem('even-publisher:wp-password', config.wordpressPassword.trim());
  localStorage.setItem('even-publisher:elevenlabs-key', config.elevenLabsApiKey.trim());
}

export function loadTopicsFromLocalStorage(): string[] {
  const raw = localStorage.getItem('even-publisher:topics') ?? '';
  return raw
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function saveTopicsToLocalStorage(topics: string[]): void {
  const normalized = topics.map((value) => value.trim()).filter((value) => value.length > 0);
  const payload = normalized.join('\n');
  localStorage.setItem('even-publisher:topics', payload);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

