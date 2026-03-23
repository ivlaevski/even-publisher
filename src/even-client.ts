import {
  CreateStartUpPageContainer,
  DeviceConnectType,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenHubEvent,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';

import type { AiNewsItem, PublisherConfig, Research, ViewName } from './types';
import {
  appendEventLog,
  clamp,
  generateId,
  loadConfigFromLocalStorage,
  loadTopicsFromLocalStorage,
  setStatus,
} from './utils';
import { elaborateResearch, fetchLatestAiNews, publishToWordPress, refineResearch, synthesizeSpeech } from './api';
import { cancelSttRecording, feedSttAudio, startSttRecording, stopSttAndTranscribe } from './stt-elevenlabs';

const STORAGE_KEY_RESEARCHES = 'even-publisher:researches';

const MAX_CONTENT_LENGTH = 2000-25;

type ResearchState = {
  researches: Research[];
};

type UiState = {
  view: ViewName;
  loadingMessage?: string;
  errorMessage?: string;
  aiNews: AiNewsItem[];
  aiSelectedIndex: number;
  researchSelectedIndex: number;
  readySelectedIndex: number;
  promptDelayDays: number;
  researchPages: string[];
  researchPageIndex: number;
  readyPages: string[];
  readyPageIndex: number;
  topics: string[];
  selectedTopic: string | null;
};

export class EvenPublisherClient {
  private bridge: EvenAppBridge;
  private isStartupCreated = false;
  private state: ResearchState = {
    researches: [],
  };
  private ui: UiState = {
    view: 'main-menu',
    aiNews: [],
    aiSelectedIndex: 0,
    researchSelectedIndex: 0,
    readySelectedIndex: 0,
    promptDelayDays: 0,
    researchPages: [],
    researchPageIndex: 0,
    readyPages: [],
    readyPageIndex: 0,
    topics: [],
    selectedTopic: null,
  };
  private isVoiceRecording = false;
  private currentResearchId: string | null = null;
  private readAloudAborted = false;
  private currentReadAloudAudio: HTMLAudioElement | null = null;
  private currentLineToRead: string | null = null;
  private readAloudLines: string[] = [];
  private readAloudLineIndex = 0;
  private cancelMode: 'draft' | 'ready' | null = null;

  constructor(bridge: EvenAppBridge) {
    this.bridge = bridge;
  }

  async init(): Promise<void> {
    const initT0 = performance.now();
    appendEventLog(`[startup] init() begin (${new Date().toISOString()})`);

    this.bridge.onEvenHubEvent((event) => {
      void this.onEvenHubEvent(event);
    });

    // Defer createStartUpPageContainer until glasses report Connected (like epub-reader).
    // Calling too early often returns StartUpPageCreateResult.invalid (1) while the hub still shows placeholder UI.
    await this.waitForGlassesConnected(12000);

    const tAfterWait = performance.now();
    appendEventLog(`[startup] after waitForGlassesConnected: +${(tAfterWait - initT0).toFixed(0)}ms`);

    await this.ensureStartupUi();

    const tAfterStartup = performance.now();
    appendEventLog(`[startup] after ensureStartupUi: +${(tAfterStartup - initT0).toFixed(0)}ms`);

    appendEventLog('[startup] loadResearches…');
    await this.loadResearches();
    appendEventLog(`[startup] loadResearches done: +${(performance.now() - initT0).toFixed(0)}ms`);

    this.ui.topics = loadTopicsFromLocalStorage();
    appendEventLog('[startup] renderMainMenu…');
    await this.renderMainMenu();
    appendEventLog(`[startup] renderMainMenu done: +${(performance.now() - initT0).toFixed(0)}ms total`);

    setStatus('Even Publisher connected. Use glasses to navigate menu.');
  }

  /** Poll until getDeviceInfo reports Connected, or timeout (browser / simulator may never report). */
  private async waitForGlassesConnected(maxMs: number): Promise<void> {
    const t0 = performance.now();
    let lastLogAt = 0;

    while (performance.now() - t0 < maxMs) {
      const d = await this.bridge.getDeviceInfo();
      const ct = d?.status?.connectType;
      const sn = d?.sn ?? '—';

      if (performance.now() - t0 - lastLogAt >= 1500) {
        appendEventLog(
          `[startup] device poll: connectType=${String(ct)} sn=${sn} (+${(performance.now() - t0).toFixed(0)}ms)`,
        );
        lastLogAt = performance.now() - t0;
      }

      if (ct === DeviceConnectType.Connected) {
        appendEventLog(`[startup] glasses Connected after ${(performance.now() - t0).toFixed(0)}ms`);
        return;
      }

      await new Promise((r) => setTimeout(r, 350));
    }

    appendEventLog(
      `[startup] still not Connected after ${maxMs}ms — continuing anyway (simulator / WebView may omit status)`,
    );
  }

  private getConfig(): PublisherConfig {
    const cfg = loadConfigFromLocalStorage();
    return {
      openAiApiKey: cfg.openAiApiKey,
      openAiModel: cfg.openAiModel,
      wordpressBaseUrl: cfg.wordpressBaseUrl,
      wordpressUsername: cfg.wordpressUsername,
      wordpressPassword: cfg.wordpressPassword,
      elevenLabsApiKey: cfg.elevenLabsApiKey,
    };
  }

  private startupResultLabel(code: number): string {
    const n = StartUpPageCreateResult.normalize(code);
    if (n === StartUpPageCreateResult.success) return 'success';
    if (n === StartUpPageCreateResult.invalid) return 'invalid';
    if (n === StartUpPageCreateResult.oversize) return 'oversize';
    if (n === StartUpPageCreateResult.outOfMemory) return 'outOfMemory';
    return `raw=${code}`;
  }

  private async ensureStartupUi(): Promise<void> {
    if (this.isStartupCreated) return;

    const d = await this.bridge.getDeviceInfo();
    appendEventLog(
      `[startup] ensureStartupUi: pre-create device connectType=${String(d?.status?.connectType ?? 'undefined')} sn=${d?.sn ?? '—'}`,
    );

    // SDK: exactly one container on the page must have isEventCapture=1; startup max 4 containers total.
    // Full border/padding fields match host validation expectations (avoids StartUpPageCreateResult.invalid).
    const title = new TextContainerProperty({
      containerID: 1,
      containerName: 'title',
      xPosition: 0,
      yPosition: 40,
      width: 576,
      height: 40,
      borderWidth: 0,
      borderColor: 5,
      borderRdaius: 0,
      paddingLength: 2,
      content: 'Even Publisher',
      isEventCapture: 0,
    });

    const hint = new TextContainerProperty({
      containerID: 2,
      containerName: 'hint',
      xPosition: 0,
      yPosition: 120,
      width: 576,
      height: 40,
      borderWidth: 0,
      borderColor: 5,
      borderRdaius: 0,
      paddingLength: 2,
      content: 'Tap to open main menu',
      isEventCapture: 1,
    });

    const startupPayload = {
      containerTotalNum: 2,
      textObject: [title, hint],
    };

    appendEventLog(
      '[startup] createStartUpPageContainer payload: containerTotalNum=2 textIds=[1,2] captureOn=[hint]',
    );

    const tryCreate = () =>
      this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(startupPayload));

    // Brief defer after Connected: native pipeline sometimes needs a tick.
    await new Promise((r) => setTimeout(r, 80));

    const tCreate0 = performance.now();
    let result = await tryCreate();
    appendEventLog(
      `[startup] createStartUpPageContainer attempt0: code=${result} (${this.startupResultLabel(result)}) +${(performance.now() - tCreate0).toFixed(0)}ms`,
    );

    if (result !== 0) {
      for (let attempt = 0; attempt < 3 && result !== 0; attempt += 1) {
        const delay = 250 * (attempt + 1);
        appendEventLog(`[startup] create retry in ${delay}ms (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, delay));
        const t1 = performance.now();
        result = await tryCreate();
        appendEventLog(
          `[startup] createStartUpPageContainer attempt${attempt + 1}: code=${result} (${this.startupResultLabel(result)}) +${(performance.now() - t1).toFixed(0)}ms`,
        );
      }
    }

    if (result === 0) {
      this.isStartupCreated = true;
      appendEventLog('[startup] createStartUpPageContainer OK — isStartupCreated=true');
      return;
    }

    appendEventLog(
      `[startup] createStartUpPageContainer final code=${result} (${this.startupResultLabel(result)}); trying rebuildPageContainer fallback`,
    );
    const tRe = performance.now();
    const rebuilt = await this.bridge.rebuildPageContainer(
      new RebuildPageContainer(startupPayload),
    );
    appendEventLog(
      `[startup] rebuildPageContainer: returned=${String(rebuilt)} typeof=${typeof rebuilt} +${(performance.now() - tRe).toFixed(0)}ms`,
    );
    if (rebuilt) {
      this.isStartupCreated = true;
      appendEventLog('[startup] Startup UI ok via rebuildPageContainer fallback.');
    } else {
      appendEventLog(
        `[startup] create failed (${this.startupResultLabel(result)}) and rebuild returned falsy — glasses may still show host placeholder; main menu rebuild may still work`,
      );
    }
  }

  private buildPages(full: string): string[] {
    const text = full ?? '';
    if (text.length <= MAX_CONTENT_LENGTH) return [text];

    const lines = text.split('\n');
    const pages: string[] = [];
    let currentLines: string[] = [];
    let currentLength = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // +1 to account for the newline we add when joining (except possibly last)
      const extra = line.length + (currentLines.length > 0 ? 1 : 0);
      if (currentLength + extra > MAX_CONTENT_LENGTH && currentLines.length > 0) {
        pages.push(currentLines.join('\n')+'... [ page break; next page number: ' + (pages.length+1) + ']\n\n');
        currentLines = [line];
        currentLength = line.length;
      } else {
        currentLines.push(line);
        currentLength += extra;
      }
    }

    if (currentLines.length > 0) {
      pages.push(currentLines.join('\n')+'... [ end ]\n\n');
    }

    return pages;
  }

  /** Split full text into pages as arrays of lines (for read-aloud: display + speak line by line). */
  private buildPagesAsLines(full: string): string[][] {
    const text = full ?? '';
    const lines = text.split('\n');
    if (lines.length === 0) return [[]];
    const result: string[][] = [];
    let current: string[] = [];
    let currentLength = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const extra = line.length + (current.length > 0 ? 1 : 0);
      if (currentLength + extra > MAX_CONTENT_LENGTH && current.length > 0) {
        result.push(current);
        current = [line];
        currentLength = line.length;
      } else {
        current.push(line);
        currentLength += extra;
      }
    }
    if (current.length > 0) result.push(current);
    return result;
  }

  private sanitizeForDisplay(text: string): string {
    if (!text) return '';
    let result = '';
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code !== undefined && code > 0xffff) {
        const hex = code.toString(16).toUpperCase().padStart(4, '0');
        result += `[ U+${hex} ]`;
      } else {
        result += ch;
      }
    }
    return result;
  }

  private async updateResearchDetailPage(research: Research): Promise<void> {
    if (!this.ui.researchPages.length) {
      const header = `${research.title}\n\n`;
      const footer =
        '\n\nScroll = Read more\nDouble-tap = Open menu (Prompt / Ready for Publish / Exit)';
      const full = header + research.content + footer;
      this.ui.researchPages = this.buildPages(full);
      this.ui.researchPageIndex = clamp(this.ui.researchPageIndex, 0, this.ui.researchPages.length - 1);
    }

    const rawPage = this.ui.researchPages[this.ui.researchPageIndex] ?? '';
    const page = this.sanitizeForDisplay(rawPage);

    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 400,
        containerName: 'research-detail',
        contentOffset: 0,
        contentLength: MAX_CONTENT_LENGTH,
        content: page,
      }),
    );
  }

  private async loadResearches(): Promise<void> {
    try {
      const raw = await this.bridge.getLocalStorage(STORAGE_KEY_RESEARCHES);
      if (!raw) {
        this.state.researches = [];
        return;
      }
      const value = JSON.parse(raw) as Research[];
      this.state.researches = Array.isArray(value) ? value : [];
    } catch {
      this.state.researches = [];
    }
  }

  private async saveResearches(): Promise<void> {
    const json = JSON.stringify(this.state.researches);
    await this.bridge.setLocalStorage(STORAGE_KEY_RESEARCHES, json);
  }

  private getDraftResearches(): Research[] {
    return this.state.researches.filter((r) => r.status === 'draft');
  }

  private getReadyResearches(): Research[] {
    return this.state.researches.filter((r) => r.status === 'ready');
  }

  private async showTextFullScreen(content: string, captureEvents = true): Promise<void> {
    const trimmed = this.sanitizeForDisplay(content.slice(0, MAX_CONTENT_LENGTH));
    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [
          new TextContainerProperty({
            containerID: 10,
            containerName: 'body',
            xPosition: 0,
            yPosition: 0,
            width: 576,
            height: 288,
            content: trimmed,
            isEventCapture: captureEvents ? 1 : 0,
          }),
        ],
      }),
    );
  }

  private async renderMainMenu(): Promise<void> {
    this.ui.view = 'main-menu';
    const items = ['Start new research', 'Continue old research', 'Review Ready for Publishing'];

    const list = new ListContainerProperty({
      containerID: 100,
      containerName: 'main-menu',
      xPosition: 0,
      yPosition: 80,
      width: 576,
      height: 176,
      borderWidth: 1,
      borderColor: 5,
      borderRdaius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    });

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 4,
        textObject: [
          new TextContainerProperty({
            containerID: 90,
            containerName: 'main-menu-title',
            xPosition: 0,
            yPosition: 10,
            width: 576,
            height: 32,
            content: 'EvenPublisher',
            isEventCapture: 0,
          }),
          new TextContainerProperty({
            containerID: 91,
            containerName: 'main-menu-subtitle',
            xPosition: 0,
            yPosition: 42,
            width: 576,
            height: 24,
            content: 'by Ivan Vlaevski v.1.0',
            isEventCapture: 0,
          }),
          new TextContainerProperty({
            containerID: 92,
            containerName: 'main-menu-footer',
            xPosition: 260,
            yPosition: 260,
            width: 316,
            height: 24,
            content: 'Revolute to @ivanvlaevski',
            isEventCapture: 0,
          }),
        ],
        listObject: [list],
      }),
    );

    setStatus('Main menu: tap to choose an option.');
  }

  private async renderNewResearchLoading(message: string): Promise<void> {
    this.ui.view = 'new-research-loading';
    this.ui.loadingMessage = message;
    await this.showTextFullScreen(message);
  }

  private async renderTopicSelect(): Promise<void> {
    this.ui.view = 'topic-select';
    const topics = this.ui.topics;

    if (!topics.length) {
      await this.showTextFullScreen(
        'No topics defined on phone.\n\nUse the phone screen to add topics, then try again.',
      );
      this.ui.view = 'error';
      return;
    }

    const items = topics.map((topic, index) => `${index + 1}. ${topic}`);
    items.push('⟵ Back to main menu');

    const list = new ListContainerProperty({
      containerID: 150,
      containerName: 'topic-select',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRdaius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    });

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        listObject: [list],
      }),
    );

    setStatus('Select a topic, then tap to continue.');
  }

  private async renderAiNewsList(): Promise<void> {
    this.ui.view = 'new-research-list';
    if (this.ui.aiNews.length === 0) {
      await this.showTextFullScreen('No AI news results.\n\nTap to return to main menu.');
      return;
    }

    const maxItems = 4;
    const pageStart = Math.floor(this.ui.aiSelectedIndex / maxItems) * maxItems;
    const selectedSlot = this.ui.aiSelectedIndex - pageStart;
    const rowHeight = Math.floor(288 / maxItems);

    const textObjects: TextContainerProperty[] = [];
    for (let i = 0; i < maxItems; i += 1) {
      const index = pageStart + i;
      const item = this.ui.aiNews[index];
      const isSelected = index === this.ui.aiSelectedIndex;
      const label = item
        ? `${index + 1}. ${item.title.slice(0, 60)}`
        : '';

      textObjects.push(
        new TextContainerProperty({
          containerID: 200 + i,
          containerName: `ai-item-${i}`,
          xPosition: 0,
          yPosition: i * rowHeight,
          width: 576,
          height: rowHeight,
          borderWidth: isSelected ? 2 : 0,
          borderColor: 5,
          paddingLength: 2,
          content: label,
          isEventCapture: isSelected ? 1 : 0,
        }),
      );
    }

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: textObjects.length,
        textObject: textObjects,
      }),
    );

    setStatus('News results: swipe to change, tap to inspect, double-tap to go back.');
  }

  private async renderAiNewsDetail(): Promise<void> {
    this.ui.view = 'new-research-detail';
    const item = this.ui.aiNews[this.ui.aiSelectedIndex];
    if (!item) {
      await this.renderAiNewsList();
      return;
    }

    const personas = Array.isArray(item.personas)
      ? (item.personas as any[])
          .map((p) => (typeof p === 'string' ? p : p?.name ?? ''))
          .filter(Boolean)
          .join(', ')
      : '';

    const lines: string[] = [];
    lines.push(item.title);
    lines.push('');
    if (personas) lines.push(`Personas: ${personas}`);
    if (item.eventDateTime) lines.push(`Event: ${item.eventDateTime}`);
    if (item.sourceUrl) lines.push(`Source: ${item.sourceUrl}`);
    lines.push('');
    lines.push(item.description);
    lines.push('');
    lines.push('Tap = Select and create research');
    lines.push('Double-tap = Back to list');

    const content = this.sanitizeForDisplay(lines.join('\n'));
    await this.showTextFullScreen(content);

    setStatus('Detail: tap to select, double-tap to go back to list.');
  }

  private async renderResearchList(): Promise<void> {
    this.ui.view = 'research-list';
    const drafts = this.getDraftResearches();

    const items = drafts.map((r, idx) => `${idx + 1}. ${r.title.slice(0, 60)}`);
    items.push('⟵ Back');

    const list = new ListContainerProperty({
      containerID: 300,
      containerName: 'research-list',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRdaius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    });

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        listObject: [list],
      }),
    );

    setStatus('Draft researches: select a research or Back.');
  }

  private async renderResearchDetail(research: Research): Promise<void> {
    this.ui.view = 'research-detail';
    this.currentResearchId = research.id;
    const header = `${research.title}\n\n`;
    const footer = '\n\nDouble-tap for menu';
    const full = header + research.content + footer;
    this.ui.researchPages = this.buildPages(full);
    this.ui.researchPageIndex = 0;
    const content = this.sanitizeForDisplay(this.ui.researchPages[0] ?? '');

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [
          new TextContainerProperty({
            containerID: 400,
            containerName: 'research-detail',
            xPosition: 0,
            yPosition: 0,
            width: 576,
            height: 288,
            borderWidth: 0,
            borderColor: 5,
            paddingLength: 4,
            content,
            isEventCapture: 1,
          }),
        ],
      }),
    );

    setStatus('Research: scroll to read, double-tap for prompt / ready / exit menu.');
  }

  private async renderReadyList(): Promise<void> {
    this.ui.view = 'ready-list';
    const ready = this.getReadyResearches();
    const items = ready.map((r, idx) => `${idx + 1}. ${r.title.slice(0, 60)}`);
    items.push('⟵ Back');

    const list = new ListContainerProperty({
      containerID: 500,
      containerName: 'ready-list',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRdaius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    });

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        listObject: [list],
      }),
    );

    setStatus('Ready for publishing: select a research or Back.');
  }

  private async renderReadyDetail(research: Research): Promise<void> {
    this.ui.view = 'ready-detail';
    this.currentResearchId = research.id;
    const delay = clamp(this.ui.promptDelayDays, 0, 10);
    const header = `${research.title}\n\nPublish delay (days): ${delay}\n\n`;
    const footer = '\n\nDouble-tap for menu';

    const full = header + research.content + footer;
    this.ui.readyPages = this.buildPages(full);
    this.ui.readyPageIndex = 0;
    const content = this.sanitizeForDisplay(this.ui.readyPages[0] ?? '');

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [
          new TextContainerProperty({
            containerID: 600,
            containerName: 'ready-detail',
            xPosition: 0,
            yPosition: 0,
            width: 576,
            height: 288,
            borderWidth: 0,
            borderColor: 5,
            paddingLength: 4,
            content,
            isEventCapture: 1,
          }),
        ],
      }),
    );
  }

  private async updateReadyDelayText(research: Research): Promise<void> {
    const delay = clamp(this.ui.promptDelayDays, 0, 10);
    const header = `${research.title}\n\nPublish delay (days): ${delay}\n\n`;
    const footer = '\n\nDouble-tap for menu';
    const full = header + research.content + footer;
    this.ui.readyPages = this.buildPages(full);
    this.ui.readyPageIndex = clamp(this.ui.readyPageIndex, 0, this.ui.readyPages.length - 1);
    const rawPage = this.ui.readyPages[this.ui.readyPageIndex] ?? '';
    const page = this.sanitizeForDisplay(rawPage);

    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 600,
        containerName: 'ready-detail',
        contentOffset: 0,
        contentLength: MAX_CONTENT_LENGTH,
        content: page,
      }),
    );
  }

  private async handleMainMenuSelect(index: number): Promise<void> {
    if (index === 0) {
      await this.startNewResearchFlow();
    } else if (index === 1) {
      await this.renderResearchList();
    } else if (index === 2) {
      await this.renderReadyList();
    }
  }

  private async startNewResearchFlow(): Promise<void> {
    const config = this.getConfig();
    if (!config.openAiApiKey) {
      await this.showTextFullScreen(
        'OpenAI API key missing.\n\nSet the key on the phone screen, then try again.',
      );
      return;
    }

    this.ui.topics = loadTopicsFromLocalStorage();
    if (this.ui.topics.length > 0 && !this.ui.selectedTopic) {
      await this.renderTopicSelect();
      return;
    }

    const topic = (this.ui.selectedTopic ?? 'Artificial Intelligence').trim() || 'Artificial Intelligence';

    await this.renderNewResearchLoading(`Loading news for "${topic}"…`);

    try {
      this.ui.aiNews = await fetchLatestAiNews(config, topic);
      this.ui.aiSelectedIndex = 0;
      this.ui.selectedTopic = null;
      await this.renderAiNewsList();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.showTextFullScreen(`Failed to fetch AI news.\n\n${message}\n\nTap to return.`);
      this.ui.view = 'error';
    }
  }

  private async createResearchFromAiSelection(): Promise<void> {
    const item = this.ui.aiNews[this.ui.aiSelectedIndex];
    if (!item) return;

    const config = this.getConfig();
    if (!config.openAiApiKey) {
      await this.showTextFullScreen(
        'OpenAI API key missing.\n\nSet the key on the phone screen, then try again.',
      );
      return;
    }

    await this.renderNewResearchLoading('Creating research draft…');

    const title = item.title || 'AI Research';
    let content: string;
    try {
      content = await elaborateResearch(config, item, title);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.showTextFullScreen(`Failed to elaborate research.\n\n${message}\n\nTap to return.`);
      this.ui.view = 'error';
      return;
    }

    const now = new Date().toISOString();
    const research: Research = {
      id: generateId(),
      title,
      content,
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      sourceJson: item.raw,
    };

    this.state.researches.push(research);
    await this.saveResearches();

    this.ui.researchSelectedIndex = this.getDraftResearches().findIndex((r) => r.id === research.id);
    await this.renderResearchDetail(research);
  }

  private async markResearchReady(research: Research): Promise<void> {
    const idx = this.state.researches.findIndex((r) => r.id === research.id);
    if (idx === -1) return;
    this.state.researches[idx] = {
      ...research,
      status: 'ready',
      updatedAt: new Date().toISOString(),
    };
    await this.saveResearches();
    await this.renderResearchList();
  }

  private async removeResearch(research: Research): Promise<void> {
    this.state.researches = this.state.researches.filter((r) => r.id !== research.id);
    if (this.currentResearchId === research.id) {
      this.currentResearchId = null;
    }
    await this.saveResearches();
  }

  public getCurrentResearch(): Research | null {
    if (!this.currentResearchId) return null;
    return this.state.researches.find((r) => r.id === this.currentResearchId) ?? null;
  }

  public async applyPromptToCurrentResearch(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setStatus('Prompt is empty. Type changes first.');
      return;
    }

    const research = this.getCurrentResearch();
    if (!research) {
      setStatus('No active research selected on glasses.');
      return;
    }

    const config = this.getConfig();
    if (!config.openAiApiKey) {
      await this.showTextFullScreen(
        'OpenAI API key missing.\n\nSet the key on the phone screen, then try again.',
      );
      return;
    }

    try {
      setStatus('Updating research with AI prompt…');
      appendEventLog(`Applying prompt to research "${research.title}"`);
      const updatedContent = await refineResearch(config, research, trimmed);

      const idx = this.state.researches.findIndex((r) => r.id === research.id);
      if (idx === -1) return;

      const now = new Date().toISOString();
      const updated: Research = {
        ...this.state.researches[idx],
        content: updatedContent,
        updatedAt: now,
      };
      this.state.researches[idx] = updated;
      await this.saveResearches();

      if (this.ui.view === 'research-detail') {
        await this.renderResearchDetail(updated);
      } else if (this.ui.view === 'ready-detail') {
        await this.renderReadyDetail(updated);
      }

      setStatus('Research updated from prompt.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.showTextFullScreen(
        `Failed to apply prompt to research.\n\n${message}\n\nTap to continue.`,
      );
      this.ui.view = 'error';
    }
  }

  private async publishCurrentReadyResearch(): Promise<void> {
    const ready = this.getReadyResearches();
    const index = this.ui.readySelectedIndex;
    const research = ready[index];
    if (!research) {
      await this.renderReadyList();
      return;
    }

    const delay = clamp(this.ui.promptDelayDays, 0, 10);
    const config = this.getConfig();
    try {
      setStatus('Publishing to WordPress…');
      await publishToWordPress(config, research, delay);
      await this.removeResearch(research);
      await this.renderMainMenu();
      setStatus('Published to WordPress and removed from lists.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.showTextFullScreen(`Failed to publish.\n\n${message}\n\nTap to go back.`);
      this.ui.view = 'error';
    }
  }

  private async openReadyMenu(research: Research): Promise<void> {
    this.ui.view = 'ready-menu';

    const items = ['Publish now', 'Cancel publishing', 'Back to ready list', 'Back to main menu'];

    const list = new ListContainerProperty({
      containerID: 650,
      containerName: 'ready-menu',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRdaius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    });

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        listObject: [list],
      }),
    );

    setStatus('Ready menu: select an action.');
  }

  private async openConfirmCancelResearch(research: Research, mode: 'draft' | 'ready'): Promise<void> {
    this.cancelMode = mode;
    this.currentResearchId = research.id;
    const isReady = mode === 'ready';
    this.ui.view = isReady ? 'confirm-cancel-ready' : 'confirm-cancel-research';

    const question = isReady
      ? `Cancel publishing and remove this research?\n\n${research.title}`
      : `Cancel research and remove it from drafts?\n\n${research.title}`;

    const items = ['Yes', 'No'];

    const list = new ListContainerProperty({
      containerID: isReady ? 751 : 351,
      containerName: isReady ? 'confirm-cancel-ready' : 'confirm-cancel-research',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRdaius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items.map((label, idx) => `${idx + 1}. ${label}`),
      }),
    });

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [
          new TextContainerProperty({
            containerID: isReady ? 750 : 350,
            containerName: isReady ? 'confirm-cancel-ready-text' : 'confirm-cancel-research-text',
            xPosition: 0,
            yPosition: 0,
            width: 576,
            height: 144,
            borderWidth: 0,
            borderColor: 5,
            paddingLength: 4,
            content: this.sanitizeForDisplay(question),
            isEventCapture: 0,
          }),
        ],
        listObject: [list],
      }),
    );

    setStatus(isReady ? 'Confirm cancel publishing (Yes / No).' : 'Confirm cancel research (Yes / No).');
  }

  private async openResearchMenu(research: Research): Promise<void> {
    this.ui.view = 'research-menu';

    const items = [
      'Read aloud',
      'Start / stop voice prompt (record)',
      'Mark as Ready for Publish',
      'Cancel research',
      'Back to draft list',
      'Back to main menu',
    ];

    const list = new ListContainerProperty({
      containerID: 350,
      containerName: 'research-menu',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRdaius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    });

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        listObject: [list],
      }),
    );

    setStatus('Research menu: select an action.');
  }

  private async startReadAloud(research: Research): Promise<void> {
    const config = this.getConfig();
    if (!config.elevenLabsApiKey?.trim()) {
      await this.showTextFullScreen(
        `${research.title}\n\n` +
          'ElevenLabs API key missing.\n\nSet the key on the phone screen, then try again.\n\nTap to continue.',
      );
      this.ui.view = 'error';
      return;
    }

    this.ui.view = 'research-read-aloud';
    this.readAloudAborted = false;
    const fullText = `${research.title}\n${research.content}`;    
    this.readAloudLines = fullText.split('\n').map((line) => line.trim());
    this.readAloudLineIndex = 0;

    setStatus('Read aloud: line by line. Tap = pause, scroll to control playback.');

    await this.renderReadAloudCurrentLine(research);
  }

  private async renderReadAloudCurrentLine(research: Research): Promise<void> {
    const lines = this.readAloudLines;
    if (!lines.length || this.readAloudLineIndex < 0 || this.readAloudLineIndex >= lines.length) {
      await this.finishReadAloud(research);
      return;
    }

    const line = lines[this.readAloudLineIndex] ?? '';

    if (line.trim().length === 0) {
      this.readAloudLineIndex += 1;
      await this.renderReadAloudCurrentLine(research);
      return;
    }

    const display = this.sanitizeForDisplay(
      `${line}\n\nTap = pause · Scroll down = next line · Scroll up = replay · Double-tap = back`,
    );

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [
          new TextContainerProperty({
            containerID: 400,
            containerName: 'research-read-aloud',
            xPosition: 0,
            yPosition: 0,
            width: 576,
            height: 288,
            borderWidth: 0,
            borderColor: 5,
            paddingLength: 4,
            content: display,
            isEventCapture: 1,
          }),
        ],
      }),
    );

    const config = this.getConfig();
    await this.playLineAsAudio(config, line, research);
  }

  private async finishReadAloud(research: Research): Promise<void> {
    this.readAloudAborted = true;
    if (this.currentReadAloudAudio) {
      this.currentReadAloudAudio.pause();
      this.currentReadAloudAudio.currentTime = 0;
      this.currentReadAloudAudio = null;
    }
    this.ui.view = 'research-detail';
    await this.renderResearchDetail(research);
  }

  private playLineAsAudio(config: PublisherConfig, line: string, research: Research): Promise<void> {
    return new Promise((resolve, reject) => {
      this.currentLineToRead = line;
      synthesizeSpeech(config, line)
        .then((arrayBuffer) => {
          if (this.readAloudAborted) {
            resolve();
            return;
          }
          if (this.currentLineToRead !== line) {
            resolve();
            return;
          }
          const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          this.currentReadAloudAudio = audio;
          audio.onended = () => {
            URL.revokeObjectURL(url);
            this.currentReadAloudAudio = null;
            if (
              this.readAloudAborted ||
              this.ui.view !== 'research-read-aloud' 
            ) {
              resolve();
              return;
            }
            this.readAloudLineIndex += 1;                        
            void this.renderReadAloudCurrentLine(research);
            resolve();
          };
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            this.currentReadAloudAudio = null;
            reject(audio.error ?? new Error('Playback failed'));
          };
          audio.play().catch(reject);
        })
        .catch(reject);
    });
  }

  private async toggleVoicePromptRecording(research: Research): Promise<void> {
    const config = this.getConfig();
    if (!config.elevenLabsApiKey) {
      await this.showTextFullScreen(
        `${research.title}\n\n` +
          'ElevenLabs API key missing.\n\nSet the key on the phone screen, then try again.',
      );
      return;
    }

    if (!this.isVoiceRecording) {
      try {
        this.ui.view = 'prompt-recording';
        await this.showTextFullScreen(
          `${research.title}\n\nListening… tap to stop, double-tap to exit.`,
        );
        await startSttRecording(this.bridge);
        this.isVoiceRecording = true;        
        setStatus('Voice prompt: listening… tap to stop, double-tap to exit.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.showTextFullScreen(
          `${research.title}\n\nFailed to start voice prompt.\n\n${message}\n\nTap to continue.`,
        );
      }
      return;
    }

    try {
      const transcript = await stopSttAndTranscribe(config.elevenLabsApiKey);
      this.isVoiceRecording = false;

      if (!transcript.trim()) {
        await this.showTextFullScreen(
          `${research.title}\n\nNo speech captured.\n\nSpeak for a bit longer and try again.`,
        );
        return;
      }

      try {
        localStorage.setItem('even-publisher:last-transcript', transcript);
      } catch {
        // ignore storage errors
      }

      await this.showTextFullScreen(
        `${research.title}\n\n` +
          'Transcribed request:\n\n' +
          `${transcript}\n\n` +
          'You can now use this text to refine the draft on the phone.',
      );
    } catch (error) {
      this.isVoiceRecording = false;
      const message = error instanceof Error ? error.message : String(error);
      await this.showTextFullScreen(
        `${research.title}\n\nFailed to transcribe speech.\n\n${message}\n\nTap to continue.`,
      );
    }
  }

  private async onEvenHubEvent(event: EvenHubEvent): Promise<void> {
    if (event.audioEvent?.audioPcm) {
      feedSttAudio(event.audioEvent.audioPcm);
      return;
    }

    if (!event.textEvent && !event.listEvent && !event.sysEvent) {
      return;
    }

    const eventType =
      event.textEvent?.eventType ??
      event.sysEvent?.eventType ??
      event.listEvent?.eventType ??
      undefined;

    if (event.listEvent && event.listEvent.containerName === 'main-menu') {
      if (
        eventType === OsEventTypeList.CLICK_EVENT ||
        eventType === undefined
      ) {
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        await this.handleMainMenuSelect(idx);
      }
      return;
    }

    if (this.ui.view === 'topic-select' && event.listEvent?.containerName === 'topic-select') {
      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        const topics = this.ui.topics;
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        if (idx >= topics.length) {
          await this.renderMainMenu();
        } else {
          const topic = topics[idx];
          this.ui.selectedTopic = topic;
          await this.startNewResearchFlow();
        }
        return;
      }
    }

    if (this.ui.view === 'new-research-list') {
      if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        this.ui.aiSelectedIndex = clamp(this.ui.aiSelectedIndex + 1, 0, this.ui.aiNews.length - 1);
        await this.renderAiNewsList();
        return;
      }
      if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
        this.ui.aiSelectedIndex = clamp(this.ui.aiSelectedIndex - 1, 0, this.ui.aiNews.length - 1);
        await this.renderAiNewsList();
        return;
      }
      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        await this.renderAiNewsDetail();
        return;
      }
      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        await this.renderMainMenu();
        return;
      }
    }

    if (this.ui.view === 'new-research-detail') {
      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        await this.createResearchFromAiSelection();
        return;
      }
      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        await this.renderAiNewsList();
        return;
      }
    }

    if (this.ui.view === 'research-list' && event.listEvent?.containerName === 'research-list') {
      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        const drafts = this.getDraftResearches();
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        if (idx === drafts.length) {
          await this.renderMainMenu();
        } else {
          const research = drafts[idx];
          if (research) {
            this.ui.researchSelectedIndex = idx;
            await this.renderResearchDetail(research);
          }
        }
        return;
      }
    }

    // Handle research detail view (also fallback by container name, in case view flag desyncs).
    if (this.ui.view === 'research-detail' || event.textEvent?.containerName === 'research-detail') {
      const drafts = this.getDraftResearches();
      const research = drafts[this.ui.researchSelectedIndex];
      if (!research) {
        await this.renderResearchList();
        return;
      }

      if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        if (this.ui.researchPageIndex < this.ui.researchPages.length - 1) {
          this.ui.researchPageIndex += 1;
        }
        await this.updateResearchDetailPage(research);
        return;
      }

      if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
        if (this.ui.researchPageIndex > 0) {
          this.ui.researchPageIndex -= 1;
        }
        await this.updateResearchDetailPage(research);
        return;
      }

      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        await this.openResearchMenu(research);
        return;
      }
    }

    if (this.ui.view === 'research-menu' && event.listEvent?.containerName === 'research-menu') {
      const drafts = this.getDraftResearches();
      const research = drafts[this.ui.researchSelectedIndex];
      if (!research) {
        await this.renderResearchList();
        return;
      }

      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        if (idx === 0) {
          await this.startReadAloud(research);
        } else if (idx === 1) {
          await this.toggleVoicePromptRecording(research);
        } else if (idx === 2) {
          await this.markResearchReady(research);
        } else if (idx === 3) {
          await this.openConfirmCancelResearch(research, 'draft');
        } else if (idx === 4) {
          await this.renderResearchList();
        } else if (idx === 5) {
          await this.renderMainMenu();
        }
        return;
      }
    }

    if (this.ui.view === 'research-read-aloud') {
      const drafts = this.getDraftResearches();
      const research = drafts[this.ui.researchSelectedIndex];
      if (!research) {
        await this.renderResearchList();
        return;
      }

      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        if (this.currentReadAloudAudio) {
          if (this.currentReadAloudAudio.paused) {
            this.currentReadAloudAudio.play();
            setStatus('Read aloud resumed. Scroll to pause or double-tap to exit.');
          } else {
            this.currentReadAloudAudio.pause();
            setStatus('Read aloud paused. Scroll to continue or double-tap to exit.');
          }
        }
        return;
      }

      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        await this.finishReadAloud(research);
        return;
      }

      if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
        if (this.currentReadAloudAudio) {
          this.currentReadAloudAudio.pause();
          this.currentReadAloudAudio.currentTime = 0;
          this.currentReadAloudAudio = null;
        }
        this.readAloudLineIndex -= 1; 
        if (this.readAloudLineIndex < 0) {
          this.readAloudLineIndex = 0;
        }
        await this.renderReadAloudCurrentLine(research);
        return;
      }

      if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        if (this.currentReadAloudAudio) {
          this.currentReadAloudAudio.pause();
          this.currentReadAloudAudio.currentTime = 0;
          this.currentReadAloudAudio = null;
        }
        this.readAloudLineIndex += 1;        
        await this.renderReadAloudCurrentLine(research);
        return;
      }
    }

    if (this.ui.view === 'prompt-recording') {
      const drafts = this.getDraftResearches();
      const research = drafts[this.ui.researchSelectedIndex];
      if (!research) {
        await this.renderResearchList();
        return;
      }

      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        if (this.isVoiceRecording) {
          await this.toggleVoicePromptRecording(research);
        }
        await this.renderResearchDetail(research);
        return;
      }      

      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        if (this.isVoiceRecording) {
          await cancelSttRecording();
          this.isVoiceRecording = false;
        }
        await this.renderResearchDetail(research);
        return;
      }
    }

    if (this.ui.view === 'ready-list' && event.listEvent?.containerName === 'ready-list') {
      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        const ready = this.getReadyResearches();
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        if (idx === ready.length) {
          await this.renderMainMenu();
        } else {
          const research = ready[idx];
          if (research) {
            this.ui.readySelectedIndex = idx;
            this.ui.promptDelayDays = 0;
            await this.renderReadyDetail(research);
          }
        }
        return;
      }
    }

    if (this.ui.view === 'ready-detail') {
      const ready = this.getReadyResearches();
      const research = ready[this.ui.readySelectedIndex];
      if (!research) {
        await this.renderReadyList();
        return;
      }

      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        this.ui.promptDelayDays = clamp(this.ui.promptDelayDays + 1, 0, 10);
        await this.updateReadyDelayText(research);
        return;
      }

      if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
        if (this.ui.readyPageIndex === 0) {
          this.ui.promptDelayDays = clamp(this.ui.promptDelayDays - 1, 0, 10);
          await this.updateReadyDelayText(research);
        } else {
          this.ui.readyPageIndex = Math.max(0, this.ui.readyPageIndex - 1);
          await this.updateReadyDelayText(research);
        }
        return;
      }

      if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        if (this.ui.readyPageIndex < this.ui.readyPages.length - 1) {
          this.ui.readyPageIndex += 1;
        }
        await this.updateReadyDelayText(research);
        return;
      }

      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        await this.openReadyMenu(research);
        return;
      }
    }

    if (this.ui.view === 'ready-menu' && event.listEvent?.containerName === 'ready-menu') {
      const ready = this.getReadyResearches();
      const research = ready[this.ui.readySelectedIndex];
      if (!research) {
        await this.renderReadyList();
        return;
      }

      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        if (idx === 0) {
          await this.publishCurrentReadyResearch();
        } else if (idx === 1) {
          await this.openConfirmCancelResearch(research, 'ready');
        } else if (idx === 2) {
          await this.renderReadyList();
        } else if (idx === 3) {
          await this.renderMainMenu();
        }
        return;
      }
    }

    if (
      (this.ui.view === 'confirm-cancel-research' &&
        event.listEvent?.containerName === 'confirm-cancel-research') ||
      (this.ui.view === 'confirm-cancel-ready' &&
        event.listEvent?.containerName === 'confirm-cancel-ready')
    ) {
      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        const research = this.getCurrentResearch();
        const mode = this.cancelMode;
        this.cancelMode = null;

        if (!research || !mode) {
          await this.renderMainMenu();
          return;
        }

        if (idx === 0) {
          // Yes
          await this.removeResearch(research);
          await this.renderMainMenu();
        } else {
          // No
          if (mode === 'draft') {
            await this.renderResearchDetail(research);
          } else {
            await this.renderReadyDetail(research);
          }
        }
        return;
      }
    }

    if (this.ui.view === 'error') {
      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        await this.renderMainMenu();
      }
    }
  }
}

