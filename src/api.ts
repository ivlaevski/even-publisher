import { GoogleGenerativeAI, SchemaType, type Schema, type Tool } from '@google/generative-ai';

import type { AiNewsItem, PublisherConfig, PublisherTopic, Research } from './types';
import { appendEventLog } from './utils';

const DEFAULT_GEMINI_NEWS_MODEL = 'gemini-3-flash-preview';
const DEFAULT_GEMINI_DRAFT_MODEL = 'gemini-3-flash-preview';
const MAX_RSS_XML_CHARS = 400_000;

function normalizeTopicInput(topicInput: PublisherTopic | string): PublisherTopic {
  if (typeof topicInput === 'string') {
    const name = topicInput.trim() || 'Artificial Intelligence';
    return { name, rssUrl: '' };
  }
  return {
    name: topicInput.name.trim() || 'Artificial Intelligence',
    rssUrl: topicInput.rssUrl.trim(),
  };
}

const NEWS_RESPONSE_SCHEMA: Schema = {
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

function requireGeminiKey(config: PublisherConfig): string {
  const key = config.googleGenerativeApiKey?.trim();
  if (!key) {
    throw new Error(
      'Google Gemini API key not configured. Add it under AI & Publishing Settings on the phone.',
    );
  }
  return key;
}

function draftGeminiModel(config: PublisherConfig): string {
  return config.googleGenerativeDraftModel?.trim() || DEFAULT_GEMINI_DRAFT_MODEL;
}

async function callGeminiGenerate(
  config: PublisherConfig,
  prompt: string,
  options?: { model?: string; useSearchGrounding?: boolean },
): Promise<string> {
  const genAI = new GoogleGenerativeAI(requireGeminiKey(config));
  const modelName = options?.model?.trim() || draftGeminiModel(config);
  const tools = options?.useSearchGrounding ? [{ google_search: {} } as Tool] : undefined;

  const model = genAI.getGenerativeModel({
    model: modelName,
    ...(tools ? { tools } : {}),
  });

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text().trim();

    if (options?.useSearchGrounding) {
      const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
      const searchHtml = groundingMetadata?.searchEntryPoint?.renderedContent;
      if (searchHtml) {
        appendEventLog(
          '[Gemini] Search grounding: display Google Search entry point where required for public apps.',
        );
      }
    }

    return text;
  } catch (error) {
    appendEventLog(`Gemini generateContent error ${error}`);
    throw error;
  }
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

function mapGeminiDevelopmentsToNewsItems(data: GeminiDevelopment[]): AiNewsItem[] {
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

function looksLikeRssXml(body: string): boolean {
  const sample = body.trim().slice(0, 500).toLowerCase();
  return (
    sample.startsWith('<?xml') ||
    sample.startsWith('<rss') ||
    sample.startsWith('<feed') ||
    sample.includes('<rss') ||
    sample.includes('<feed')
  );
}

function truncateRssXml(xml: string): string {
  if (xml.length <= MAX_RSS_XML_CHARS) return xml;
  appendEventLog(`RSS feed truncated from ${xml.length} to ${MAX_RSS_XML_CHARS} characters.`);
  return `${xml.slice(0, MAX_RSS_XML_CHARS)}\n<!-- truncated -->`;
}

async function fetchRssXml(feedUrl: string): Promise<string> {
  const url = feedUrl.trim();
  appendEventLog(`Fetching RSS feed: ${url}`);

  const res = await fetch(url, {
    headers: {
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RSS feed error ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.text();
  if (!looksLikeRssXml(body)) {
    throw new Error('RSS feed did not return XML.');
  }

  return truncateRssXml(body.trim());
}

async function generateNewsFromGeminiJson(
  config: PublisherConfig,
  prompt: string,
  options?: { useSearchGrounding?: boolean },
): Promise<AiNewsItem[]> {
  const genAI = new GoogleGenerativeAI(requireGeminiKey(config));
  const model = genAI.getGenerativeModel({
    model: DEFAULT_GEMINI_NEWS_MODEL,
    ...(options?.useSearchGrounding ? { tools: [{ google_search: {} } as Tool] } : {}),
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: NEWS_RESPONSE_SCHEMA,
    },
  });

  let data: GeminiDevelopment[] = [];

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    data = JSON.parse(text) as GeminiDevelopment[];

    if (options?.useSearchGrounding) {
      const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
      const searchHtml = groundingMetadata?.searchEntryPoint?.renderedContent;
      if (searchHtml) {
        appendEventLog(
          '[Gemini] Search grounding: display Google Search entry point where required for public apps.',
        );
      }
    }
  } catch (error) {
    appendEventLog(`Gemini news extraction error ${error}`);
    throw error;
  }

  if (data.length === 0) {
    appendEventLog('Gemini returned no developments.');
  }

  return mapGeminiDevelopmentsToNewsItems(data);
}

async function fetchNewsViaGeminiSearch(
  config: PublisherConfig,
  topicName: string,
): Promise<AiNewsItem[]> {
  const prompt = `Find the 10 most recent and discussion-worthy developments about ${topicName}. Focus on events from the last 30 days. Search priority on official website, newsroom, blog, press release pages, official social accounts, reposts and reactions on social media.`;
  return generateNewsFromGeminiJson(config, prompt, { useSearchGrounding: true });
}

async function fetchNewsFromRssFeed(
  config: PublisherConfig,
  topic: PublisherTopic,
): Promise<AiNewsItem[]> {
  const rssXml = await fetchRssXml(topic.rssUrl);
  const prompt =
    `You are given an RSS or Atom feed in XML format.\n` +
    `Select up to 10 items from this feed that are most relevant to the topic "${topic.name}".\n` +
    'Rules:\n' +
    '- Use ONLY articles, titles, dates, summaries, and URLs that appear in the XML below.\n' +
    '- Do NOT invent articles, dates, or links.\n' +
    '- Prefer the most recent relevant items.\n' +
    '- If fewer than 10 items match the topic, return only those that match.\n' +
    '- For each result, set source_url to the article link from the feed item.\n' +
    '\n' +
    `RSS XML:\n${rssXml}`;

  return generateNewsFromGeminiJson(config, prompt);
}

/**
 * Fetches recent developments for a topic.
 * Uses Google Search grounding when no RSS URL is configured; otherwise parses the RSS feed XML via Gemini.
 */
export async function fetchLatestAiNews(
  config: PublisherConfig,
  topicInput: PublisherTopic | string,
): Promise<AiNewsItem[]> {
  const topic = normalizeTopicInput(topicInput);

  if (topic.rssUrl) {
    return fetchNewsFromRssFeed(config, topic);
  }

  return fetchNewsViaGeminiSearch(config, topic.name);
}

export async function elaborateResearch(
  config: PublisherConfig,
  selected: AiNewsItem,
  researchTitle: string,
): Promise<string> {
  const sourceUrl = selected.sourceUrl?.trim() || '';
  const sourceHint = sourceUrl
    ? `Candidate source URL (verify with Google Search before including): ${sourceUrl}`
    : 'No source URL was provided — use Google Search to find and verify an authoritative link for this event.';

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
    '- Include a "Source:" line with a verified news source link.\n' +
    '- Add a final disclaimer stating that the content was generated with the assistance of AI.\n' +
    '\n' +
    'Source verification (required):\n' +
    '- Use Google Search to confirm the event and validate any source URL before writing.\n' +
    '- Do NOT invent or guess URLs. Only include a link you can ground in search results.\n' +
    '- If the candidate URL is wrong or unverifiable, search for the correct authoritative page instead.\n' +
    '- If no reliable source can be found, write "Source: (unable to verify a primary link)" instead of fabricating one.\n' +
    '\n' +
    'Content tone guidelines:\n' +
    '- Write as someone with decades of experience observing multiple technology waves.\n' +
    '- Maintain a balance between philosophical reflection and practical industry insight.\n' +
    '- End with a memorable concluding statement that reframes the topic or raises a deeper question.\n' +
    `\n${sourceHint}\n` +
    `Title: ${researchTitle}\n` +
    `JSON: ${JSON.stringify(selected.raw ?? selected)}`;

  return callGeminiGenerate(config, prompt, { useSearchGrounding: true });
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
    '- Do not invent or alter source URLs unless the requested changes explicitly ask you to verify or update them.\n' +
    '- Return only the updated LinkedIn message as plain text (no markdown, no JSON).';

  const bodyText =
    `${instruction}\n\n` +
    `Message:\n${research.content}\n\n` +
    `Changes:\n${prompt}\n`;

  return callGeminiGenerate(config, bodyText);
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
const ELEVENLABS_DEFAULT_VOICE_ID = 'rWArYo7a2NWuBYf5BE4V';// '21m00Tcm4TlvDq8ikWAM';

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

  //appendEventLog(`Synthesizing speech for ${trimmed}`);

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
    appendEventLog(`ElevenLabs TTS error ${res.status}: ${errText}`);
    throw new Error(`ElevenLabs TTS error ${res.status}: ${errText}`);
  } else {
    //appendEventLog(`ElevenLabs TTS success`);
  }

  return res.arrayBuffer();
}
