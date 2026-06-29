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

export interface PublisherTopic {
  name: string;
  /** Optional RSS feed URL. When set, news is discovered only from that feed's XML. */
  rssUrl: string;
}

/** Payload queued when a research is submitted to WordPress. */
export interface LastPublishedInput {
  title: string;
  content: string;
  publishedAt: string;
  sourceJson?: unknown;
}

/** Snapshot shown on the phone “Last Published” tab. */
export interface LastPublishedSnapshot {
  title: string;
  socialCopy: string;
  sourceUrl: string | null;
  publishedAt: string;
  imageMimeType?: string;
  imageDataUrl?: string;
  imageError?: string;
}

export interface PublisherConfig {
  /** Google Gemini API key — news, draft elaboration, and refinement. */
  googleGenerativeApiKey: string;
  /** Gemini model for elaborating drafts and refining research text. */
  googleGenerativeDraftModel: string;
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
  | 'research-read-aloud-unlock-hint'
  | 'ready-list'
  | 'ready-detail'
  | 'ready-menu'
  | 'confirm-cancel-ready'
  | 'prompt-recording'
  | 'error';

