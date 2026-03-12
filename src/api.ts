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

export async function fetchLatestAiNews(config: PublisherConfig): Promise<AiNewsItem[]> {
  const prompt =
    'List for me the latest 5 news in AI with shotest posible description, related personas, and event date\\time in JSON format. ' +
    'Respond ONLY with a compact JSON array of items like: ' +
    '[{"title": "...", "description": "...", "personas": ["CTO", "ML engineer"], "eventDateTime": "2026-03-12T10:00:00Z"}].';

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
    temperature: 0.3,
  });

  const content = response.choices?.[0]?.message?.content ?? '[]';
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    appendEventLog(`Failed to parse OpenAI response as JSON, content="${content.slice(0, 200)}"`);
    throw error;
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Expected OpenAI response to be a JSON array');
  }

  return (parsed as any[]).map((item) => ({
    title: String(item.title ?? ''),
    description: String(item.description ?? ''),
    personas: item.personas ?? [],
    eventDateTime: item.eventDateTime ? String(item.eventDateTime) : undefined,
    raw: item,
  }));
}

export async function elaborateResearch(
  config: PublisherConfig,
  selected: AiNewsItem,
  researchTitle: string,
): Promise<string> {
  const prompt =
    'Elaborate on the following topic and build a short LinkedIn post about it following my style of Linkedin messages:\n' +
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

  let date: string | undefined;
  if (delayDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() + delayDays);
    date = d.toISOString();
  }

  const credentials = btoa(`${config.wordpressUsername}:${config.wordpressPassword}`);

  const body: Record<string, unknown> = {
    title: research.title,
    content: research.content,
    status: delayDays > 0 ? 'future' : 'publish',
  };
  if (date) body.date_gmt = date;

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

