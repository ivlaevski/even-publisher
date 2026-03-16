export type ResearchStatus = 'draft' | 'ready' | 'published';

export type PersonaInfo = {
  name: string;
  role?: string;
};

export type AiNewsItem = {
  title: string;
  description: string;
  personas: PersonaInfo[] | string[];
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
  | 'research-read-aloud'
  | 'ready-list'
  | 'ready-detail'
  | 'ready-menu'
  | 'prompt-recording'
  | 'error';

