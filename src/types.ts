export type ResearchStatus = 'draft' | 'ready' | 'published';

export type AiNewsItem = {
  title: string;
  description: string;
  eventDateTime?: string;
  sourceUrl?: string;
  raw: unknown;
};

export type ResearchId = string;

export interface Research {
  id: ResearchId;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  status: ResearchStatus;
  sourceJson?: unknown;
  scheduledPublishAt?: string;
  hashtags?: string[];
}

export interface PublisherConfig {
  /** Google Gemini API key — used only for `fetchLatestAiNews` (Generative AI + search grounding). */
  googleGenerativeApiKey: string;
  openAiApiKey: string;
  openAiModel: string;
  wordpressBaseUrl: string;
  wordpressUsername: string;
  wordpressPassword: string;
  elevenLabsApiKey: string;
}

export type ViewName =
  | 'main-menu'
  | 'topic-select'
  | 'new-research-loading'
  | 'new-research-list'
  | 'new-research-detail'
  | 'research-list'
  | 'research-detail'
  | 'research-menu'
  | 'confirm-cancel-research'
  | 'research-read-aloud'
  | 'ready-list'
  | 'ready-detail'
  | 'ready-menu'
  | 'confirm-cancel-ready'
  | 'prompt-recording'
  | 'error';

