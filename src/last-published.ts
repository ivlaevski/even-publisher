import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';

import type { LastPublishedInput, LastPublishedSnapshot, PublisherConfig } from './types';
import { appendEventLog } from './utils';

export const LAST_PUBLISHED_PENDING_KEY = 'article-publisher:last-published-pending';
export const LAST_PUBLISHED_SNAPSHOT_KEY = 'article-publisher:last-published';
export const LAST_PUBLISHED_IMAGE_KEY = 'article-publisher:last-published-image';

const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
const AI_DISCLAIMER = 'This content was generated with the assistance of AI.';

declare global {
  interface Window {
    __evenPublisherLastPublishedPending?: () => void;
    __articlePublisherShowPage?: (pageId: string) => void;
  }
}

function requireGeminiKey(config: PublisherConfig): string {
  const key = config.googleGenerativeApiKey?.trim();
  if (!key) {
    throw new Error(
      'Google Gemini API key not configured. Add it under AI & Publishing Settings on the phone.',
    );
  }
  return key;
}

function extractCandidateSourceUrl(content: string, sourceJson?: unknown): string {
  const fromLine = content.match(/^\s*Source:\s*(.+)$/im)?.[1]?.trim();
  if (fromLine && !fromLine.startsWith('(')) return fromLine;

  if (sourceJson && typeof sourceJson === 'object') {
    const record = sourceJson as { source_url?: unknown; sourceUrl?: unknown; link?: unknown };
    const candidate = record.source_url ?? record.sourceUrl ?? record.link;
    if (candidate) return String(candidate).trim();
  }

  const urlMatch = content.match(/https?:\/\/[^\s)\]>]+/i);
  return urlMatch?.[0]?.trim() ?? '';
}

export function notifyLastPublishedPending(): void {
  window.__evenPublisherLastPublishedPending?.();
  window.dispatchEvent(new CustomEvent('article-publisher:last-published-pending'));
}

export async function enqueueLastPublishedPending(
  bridge: EvenAppBridge | null,
  input: LastPublishedInput,
): Promise<void> {
  const payload = JSON.stringify(input);
  if (bridge) {
    await bridge.setLocalStorage(LAST_PUBLISHED_PENDING_KEY, payload);
  } else {
    try {
      localStorage.setItem(LAST_PUBLISHED_PENDING_KEY, payload);
    } catch {
      /* ignore storage errors */
    }
  }
  appendEventLog(`Queued Last Published payload: "${input.title}"`);
}

async function readStorageValue(bridge: EvenAppBridge | null, key: string): Promise<string> {
  if (bridge) return (await bridge.getLocalStorage(key)) ?? '';
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

async function writeStorageValue(bridge: EvenAppBridge | null, key: string, value: string): Promise<void> {
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

export async function loadLastPublishedSnapshot(
  bridge: EvenAppBridge | null,
): Promise<LastPublishedSnapshot | null> {
  const raw = await readStorageValue(bridge, LAST_PUBLISHED_SNAPSHOT_KEY);
  if (!raw.trim()) return null;
  try {
    const snapshot = JSON.parse(raw) as LastPublishedSnapshot;
    const imageRaw = await readStorageValue(bridge, LAST_PUBLISHED_IMAGE_KEY);
    if (imageRaw.trim() && !snapshot.imageDataUrl) {
      try {
        const image = JSON.parse(imageRaw) as { mimeType?: string; dataUrl?: string };
        if (image.dataUrl) {
          snapshot.imageDataUrl = image.dataUrl;
          snapshot.imageMimeType = image.mimeType;
        }
      } catch {
        /* ignore corrupt image payload */
      }
    }
    return snapshot;
  } catch {
    return null;
  }
}

async function saveLastPublishedSnapshot(
  bridge: EvenAppBridge | null,
  snapshot: LastPublishedSnapshot,
): Promise<void> {
  const { imageDataUrl, imageMimeType, ...rest } = snapshot;
  await writeStorageValue(bridge, LAST_PUBLISHED_SNAPSHOT_KEY, JSON.stringify(rest));

  if (imageDataUrl) {
    try {
      await writeStorageValue(
        bridge,
        LAST_PUBLISHED_IMAGE_KEY,
        JSON.stringify({ mimeType: imageMimeType ?? 'image/png', dataUrl: imageDataUrl }),
      );
    } catch (error) {
      appendEventLog(`Could not persist Last Published image: ${error}`);
    }
  }
}

export async function readLastPublishedPending(
  bridge: EvenAppBridge | null,
): Promise<LastPublishedInput | null> {
  const raw = await readStorageValue(bridge, LAST_PUBLISHED_PENDING_KEY);
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as LastPublishedInput;
  } catch {
    return null;
  }
}

async function clearLastPublishedPending(bridge: EvenAppBridge | null): Promise<void> {
  await writeStorageValue(bridge, LAST_PUBLISHED_PENDING_KEY, '');
}

export async function buildSocialMediaCopy(
  config: PublisherConfig,
  input: LastPublishedInput,
): Promise<{ text: string; sourceUrl: string | null }> {
  const candidateSource = extractCandidateSourceUrl(input.content, input.sourceJson);
  const sourceHint = candidateSource
    ? `Candidate source URL (validate with Google Search): ${candidateSource}`
    : 'No candidate source URL was found — use Google Search to find a verified link for this article, or state that verification failed.';

  const prompt =
    'Prepare one plain-text block for copying to social media (LinkedIn, X, etc.) from this published article.\n' +
    'Requirements:\n' +
    '- Line 1: article title\n' +
    '- Blank line, then the message body as plain text (keep emojis and short paragraphs)\n' +
    '- Include a "Source:" line with a URL validated via Google Search (do not invent links)\n' +
    '- Include 4-6 relevant hashtags near the end\n' +
    `- End with this exact disclaimer line: ${AI_DISCLAIMER}\n` +
    '- Return ONLY the final plain text (no markdown, no JSON, no commentary)\n' +
    '- Do not duplicate the title inside the body\n' +
    `\n${sourceHint}\n` +
    `Title: ${input.title}\n` +
    `Article content:\n${input.content}`;

  const key = requireGeminiKey(config);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${encodeURIComponent(key)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini social copy error ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim() ?? '';
  if (!text) {
    throw new Error('Gemini returned empty social copy.');
  }

  const sourceUrl =
    text.match(/^\s*Source:\s*(.+)$/im)?.[1]?.trim() ??
    (candidateSource || null);

  return { text, sourceUrl: sourceUrl && !sourceUrl.startsWith('(') ? sourceUrl : null };
}

export async function generateSocialMediaImage(
  config: PublisherConfig,
  title: string,
  socialCopy: string,
): Promise<{ mimeType: string; dataUrl: string }> {
  const key = requireGeminiKey(config);
  const model = DEFAULT_GEMINI_IMAGE_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const excerpt = socialCopy.replace(/\s+/g, ' ').trim().slice(0, 600);
  const prompt =
    `Create a single professional editorial illustration for a LinkedIn technology leadership post.\n` +
    `Post title: ${title}\n` +
    `Post theme: ${excerpt}\n` +
    'Style: calm, modern, abstract or semi-realistic, suitable as a social media header image. ' +
    'No text, letters, numbers, logos, or watermarks in the image.';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini image error ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    candidates?: {
      content?: {
        parts?: { inlineData?: { mimeType?: string; data?: string } }[];
      };
    }[];
  };

  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part.inlineData;
    if (inline?.data) {
      const mimeType = inline.mimeType || 'image/png';
      return {
        mimeType,
        dataUrl: `data:${mimeType};base64,${inline.data}`,
      };
    }
  }

  throw new Error('Gemini did not return an image.');
}

let processingPending = false;

export async function processLastPublishedPending(
  bridge: EvenAppBridge | null,
  config: PublisherConfig,
  hooks: {
    onStatus: (message: string) => void;
    onSnapshot: (snapshot: LastPublishedSnapshot) => void;
    onError: (message: string) => void;
  },
): Promise<boolean> {
  if (processingPending) return false;

  const pending = await readLastPublishedPending(bridge);
  if (!pending) return false;

  processingPending = true;
  await clearLastPublishedPending(bridge);

  try {
    hooks.onStatus('Preparing social copy…');
    appendEventLog(`Last Published: preparing social copy for "${pending.title}"`);

    let socialCopy = '';
    let sourceUrl: string | null = null;
    try {
      const built = await buildSocialMediaCopy(config, pending);
      socialCopy = built.text;
      sourceUrl = built.sourceUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendEventLog(`Last Published social copy error: ${message}`);
      socialCopy = `${pending.title}\n\n${pending.content}\n\n${AI_DISCLAIMER}`;
      hooks.onError(`Social copy used fallback text: ${message}`);
    }

    const snapshot: LastPublishedSnapshot = {
      title: pending.title,
      socialCopy,
      sourceUrl,
      publishedAt: pending.publishedAt,
    };
    hooks.onSnapshot({ ...snapshot });
    await saveLastPublishedSnapshot(bridge, snapshot);

    hooks.onStatus('Generating image…');
    appendEventLog(`Last Published: generating image for "${pending.title}"`);

    try {
      const image = await generateSocialMediaImage(config, pending.title, socialCopy);
      snapshot.imageMimeType = image.mimeType;
      snapshot.imageDataUrl = image.dataUrl;
      hooks.onSnapshot({ ...snapshot });
      await saveLastPublishedSnapshot(bridge, snapshot);
      hooks.onStatus('Ready to copy and share.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      snapshot.imageError = message;
      appendEventLog(`Last Published image error: ${message}`);
      hooks.onSnapshot({ ...snapshot });
      await saveLastPublishedSnapshot(bridge, snapshot);
      hooks.onStatus('Social copy ready. Image generation failed — try again.');
      hooks.onError(message);
    }

    return true;
  } finally {
    processingPending = false;
  }
}

export async function regenerateLastPublishedImage(
  bridge: EvenAppBridge | null,
  config: PublisherConfig,
  snapshot: LastPublishedSnapshot,
  onStatus: (message: string) => void,
): Promise<LastPublishedSnapshot> {
  onStatus('Generating image…');
  const image = await generateSocialMediaImage(config, snapshot.title, snapshot.socialCopy);
  const next: LastPublishedSnapshot = {
    ...snapshot,
    imageMimeType: image.mimeType,
    imageDataUrl: image.dataUrl,
    imageError: undefined,
  };
  await saveLastPublishedSnapshot(bridge, next);
  onStatus('Ready to copy and share.');
  return next;
}

export function saveImageToPhone(imageDataUrl: string, title: string): void {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const filename = `${slug || 'article-publisher'}-${Date.now()}.png`;

  const anchor = document.createElement('a');
  anchor.href = imageDataUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
