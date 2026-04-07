import { GoogleGenerativeAI, SchemaType, type Schema, type Tool } from '@google/generative-ai';

import type { AiNewsItem, PublisherConfig, Research } from './types';
import { appendEventLog } from './utils';

async function callOpenAi<T>(config: PublisherConfig, body: unknown): Promise<T> {
  const url = 'https://api.openai.com/v1/chat/completions';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openAiApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as any;
  return json as T;
}

function normalizeDashes(input: string): string {
  return input.replace(/\u2014/g, ' - ');
}

/** Collapse whitespace and cap length for Gemini summary text → description. */
function snippetToDescription(snippet: string, maxWords: number): string {
  const words = snippet.replace(/\s+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}…`;
}

interface GeminiDevelopment {
  title: string;
  date: string;
  summary: string;
  source_url: string;
  why_noteworthy: string;
}

/**
 * Fetches recent developments via Gemini with Google Search grounding and structured JSON output.
 * OpenAI is not used here.
 */
export async function fetchLatestAiNews(
  config: PublisherConfig,
  topicInput: string,
): Promise<AiNewsItem[]> {
  const key = config.googleGenerativeApiKey?.trim();
  if (!key) {
    throw new Error(
      'Google Gemini API key not configured. Add it under AI & Publishing Settings on the phone.',
    );
  }

  const defaultTopic = 'Artificial Intelligence';
  const topic = (topicInput && topicInput.trim()) || defaultTopic;

  const responseSchema: Schema = {
    description: 'List of recent developments',
    type: SchemaType.ARRAY,
    items: {
      type: SchemaType.OBJECT,
      properties: {
        title: { type: SchemaType.STRING },
        date: { type: SchemaType.STRING },
        summary: { type: SchemaType.STRING },
        source_url: { type: SchemaType.STRING },
        why_noteworthy: { type: SchemaType.STRING },
      },
      required: ['title', 'date', 'summary', 'source_url', 'why_noteworthy'],
    },
  };

  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({
    model: 'gemini-3-flash-preview',
    // Gemini 2.0+ / 3.x: `google_search` in JSON (SDK types only list legacy `googleSearchRetrieval`).
    tools: [{ google_search: {} } as Tool],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  });

  const prompt = `Find the 10 most recent and discussion-worthy developments about ${topic}. Focus on events from the last 30 days. Search priority on official website, newsroom, blog, press release pages, official social accounts, reposts and reactions on social media.`;

  let data: GeminiDevelopment[] = [];

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    data = JSON.parse(text) as GeminiDevelopment[];

    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    const searchHtml = groundingMetadata?.searchEntryPoint?.renderedContent;
    if (searchHtml) {
      appendEventLog(
        '[Gemini] Search grounding: display Google Search entry point where required for public apps.',
      );
    }
  } catch (error) {
    appendEventLog(`Gemini fetchLatestAiNews error ${error}`);
    throw error;
  }

  if (data.length === 0) {
    appendEventLog('Gemini returned no developments.');
  }

  return data.map((item) => {
    const rawTitle = String(item.title ?? '').trim() || 'Untitled';
    const body = [item.summary, item.why_noteworthy].filter(Boolean).join('\n\n');
    return {
      title: normalizeDashes(rawTitle),
      description: normalizeDashes(snippetToDescription(body, 80)),
      eventDateTime: item.date ? String(item.date) : undefined,
      sourceUrl: item.source_url ? String(item.source_url) : undefined,
      raw: item,
    };
  });
}

export async function elaborateResearch(
  config: PublisherConfig,
  selected: AiNewsItem,
  researchTitle: string,
): Promise<string> {
  const prompt =
    'Write a LinkedIn post in the voice of a seasoned technology leader reflecting on the deeper implications of a technology or AI-related event.' +
    '\n' +
    'Style requirements:\n' +
    '- The tone must be thoughtful, reflective, and authoritative, with calm leadership insight.\n' +
    '- Avoid hype, marketing language, or sensationalism.\n' +
    '- The message should combine philosophical reflection with practical technology leadership perspective.\n' +
    '- Focus on long-term consequences of technology, human behavior, trust, leadership responsibility, and organizational transformation.\n' +
    '- Use subtle intellectual irony or light philosophical humor where appropriate.\n' +
    '\n' +
    'Structure:\n' +
    '1. Start with a philosophical or thought-provoking opening statement about technology, progress, truth, or change.\n' +
    '2. Introduce the real-world event or news briefly.\n' +
    '3. Expand the context by explaining what this event signals about broader technological or organizational shifts.\n' +
    '4. Provide reflection from the perspective of engineering leadership and human impact.\n' +
    '5. Conclude with a strong insight, leadership lesson, or thought-provoking question.\n' +
    '\n' +
    'Formatting requirements:\n' +
    '- Maximum 500 words.\n' +
    '- Plain text only.\n' +
    '- Use short paragraphs (1-5 sentences each) for LinkedIn readability.\n' +
    '- Include a few relevant emojis to emphasize key ideas.\n' +
    '- Do NOT use markdown formatting.\n' +
    '\n' +
    'Additional requirements:\n' +
    '- Add 4-6 relevant hashtags at the end.\n' +
    '- Include a "Source:" line with the news source link.\n' +
    '- Add a final disclaimer stating that the content was generated with the assistance of AI.\n' +
    '\n' +
    'Content tone guidelines:\n' +
    '- Write as someone with decades of experience observing multiple technology waves.\n' +
    '- Maintain a balance between philosophical reflection and practical industry insight.\n' +
    '- End with a memorable concluding statement that reframes the topic or raises a deeper question.\n' +
    `Title: ${researchTitle}\n` +
    `JSON: ${JSON.stringify(selected.raw ?? selected)}`;

  const response = await callOpenAi<{
    choices: { message: { content?: string } }[];
  }>(config, {
    model: config.openAiModel || 'gpt-4.1-mini',
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0.7,
  });

  const content = response.choices?.[0]?.message?.content ?? '';
  return content.trim();
}

export async function refineResearch(
  config: PublisherConfig,
  research: Research,
  prompt: string,
): Promise<string> {
  const instruction =
    'Update the given LinkedIn message with the following changes.\n' +
    '- Keep the tone and voice consistent with the original message.\n' +
    '- Apply only the requested changes; do not rewrite everything from scratch unless explicitly asked.\n' +
    '- Preserve any links, emojis and hashtags unless the requested changes say otherwise.\n' +
    '- Return only the updated LinkedIn message as plain text (no markdown, no JSON).';

  const bodyText =
    `${instruction}\n\n` +
    `Message:\n${research.content}\n\n` +
    `Changes:\n${prompt}\n`;

  const response = await callOpenAi<{
    choices: { message: { content?: string } }[];
  }>(config, {
    model: config.openAiModel || 'gpt-4.1-mini',
    messages: [
      {
        role: 'user',
        content: bodyText,
      },
    ],
    temperature: 0.7,
  });

  const content = response.choices?.[0]?.message?.content ?? '';
  return content.trim();
}

export async function publishToWordPress(
  config: PublisherConfig,
  research: Research,
  delayDays: number,
): Promise<void> {
  if (!config.wordpressBaseUrl) throw new Error('WordPress base URL not configured');
  if (!config.wordpressUsername || !config.wordpressPassword) {
    throw new Error('WordPress credentials not configured');
  }

  const base = config.wordpressBaseUrl.replace(/\/+$/, '');
  const url = `${base}/wp-json/wp/v2/posts`;

  const credentials = btoa(`${config.wordpressUsername}:${config.wordpressPassword}`);

  appendEventLog(`Publishing to WordPress at ${url} (delayDays=${delayDays})`);

  const body: Record<string, unknown> = {
    title: research.title,
    content: research.content,
    status: 'draft',
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${credentials}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WordPress error ${res.status}: ${text}`);
  }
}

/** Default voice for TTS (ElevenLabs) */
const ELEVENLABS_DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

/**
 * Synthesize speech from text using ElevenLabs TTS.
 * Returns audio as MP3 bytes (playable in browser via Audio/Blob).
 */
export async function synthesizeSpeech(
  config: PublisherConfig,
  text: string,
): Promise<ArrayBuffer> {
  if (!config.elevenLabsApiKey?.trim()) {
    throw new Error('ElevenLabs API key not configured');
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Text to speak is empty');
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_DEFAULT_VOICE_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': config.elevenLabsApiKey.trim(),
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: trimmed,
      model_id: 'eleven_multilingual_v2',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs TTS error ${res.status}: ${errText}`);
  }

  return res.arrayBuffer();
}

