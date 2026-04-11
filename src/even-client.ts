import {
  CreateStartUpPageContainer,
  DeviceConnectType,
  ListContainerProperty,
  ListItemContainerProperty,
  List_ItemEvent,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  Sys_ItemEvent,
  TextContainerProperty,
  TextContainerUpgrade,
  Text_ItemEvent,
  evenHubEventFromJson,
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
import {
  hasPhonePlaybackPrimedThisSession,
  prepareSharedPlaybackFromMp3,
  revokeSharedPlaybackBlobUrl,
} from './phone-audio';
import {
  cancelSttRecording,
  feedSttAudio,
  setSttLiveListener,
  startSttRecording,
  stopSttAndTranscribe,
  type SttLivePayload,
} from './stt-elevenlabs';

const STORAGE_KEY_RESEARCHES = 'article-publisher:researches';

const MAX_CONTENT_LENGTH = 900;
const MAX_CONTENT_LENGTH_TOTAL = 2000;

/** Minimal typings for optional browser Speech Recognition (not always in TS `lib`). */
type VoiceSpeechRecognitionResult = {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
};

type VoiceSpeechRecognitionEvent = {
  readonly resultIndex: number;
  readonly results: ArrayLike<VoiceSpeechRecognitionResult> & { length: number };
};

type VoiceSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: VoiceSpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
};

/** Top-left timer overlay for `showTextFullScreenWithTimer` (must match `textContainerUpgrade` calls). */
const FULL_SCREEN_TIMER_CONTAINER_ID = 11;

/** Voice prompt recording full screen — IDs/names must match `textContainerUpgrade` calls. */
const VOICE_PROMPT_INFO_CONTAINER_ID = 2;
const VOICE_PROMPT_CONTEXT_CONTAINER_ID = 12;
const VOICE_PROMPT_TRANSCRIPT_CONTAINER_ID = 13;

function formatElapsedMmSs(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

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

  /** Cleared whenever the glasses page is rebuilt so upgrades never hit a stale container. */
  private fullScreenTimerInterval: ReturnType<typeof setInterval> | null = null;
  private fullScreenTimerStartedAtMs: number | null = null;

  private voicePromptDurationLine = '';
  private voicePromptInterimFromSr = '';
  private voicePromptSrCommitted = '';
  private voicePromptSpeechRec: VoiceSpeechRecognition | null = null;
  private voicePromptTranscriptFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(bridge: EvenAppBridge) {
    this.bridge = bridge;
  }

  async init(): Promise<void> {
    await this.waitForGlassesConnected(12000);
    await this.ensureStartupUi();
    await this.loadResearches();
    this.ui.topics = loadTopicsFromLocalStorage();
    await new Promise((r) => setTimeout(r, 3500));
    await this.renderMainMenu();

    this.bridge.onEvenHubEvent((raw) => {
      const event = this.normalizeIncomingHubEvent(raw);
      void this.onEvenHubEvent(event);
    });
    setStatus('Article Publisher connected. Use glasses to navigate menu.');
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
      googleGenerativeApiKey: cfg.googleGenerativeApiKey,
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

    const title = new TextContainerProperty({
      containerID: 1,
      containerName: 'title',
      xPosition: 20,
      yPosition: 40,
      width: 300,
      height: 140,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 2,
      content: 'Article Publisher for WordPress\n---------------------------\nProductivity wherever you go',
      isEventCapture: 0,
    });

    const hint = new TextContainerProperty({
      containerID: 2,
      containerName: 'hint',
      xPosition: 20,
      yPosition: 200,
      width: 300,
      height: 40,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 2,
      content: 'Wait application to load...',
      isEventCapture: 1,
    });

    const container = new CreateStartUpPageContainer({
      containerTotalNum: 2,
      textObject: [title, hint],
    });

    //await new Promise((r) => setTimeout(r, 50));

    let result = await this.bridge.createStartUpPageContainer(container);

    if (result === 0) {
      this.isStartupCreated = true;
      return;
    }

    appendEventLog(
      `createStartUpPageContainer code=${result}; trying rebuildPageContainer fallback`,
    );

    // const rebuilt = await this.applyRebuildPageContainer(
    //   new RebuildPageContainer(container),
    // );
    // if (rebuilt) {
    //   this.isStartupCreated = true;
    //   appendEventLog('Startup UI ok via rebuildPageContainer fallback.');
    // } else {
    //   appendEventLog(`Failed to create startup page: code=${result}`);
    // }
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
        pages.push(currentLines.join('\n'));// + '... [ page break; next page number: ' + (pages.length + 1) + ']\n\n');
        currentLines = [line];
        currentLength = line.length;
      } else {
        currentLines.push(line);
        currentLength += extra;
      }
    }

    if (currentLines.length > 0) {
      pages.push(currentLines.join('\n') + '... [ end ]\n\n');
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

  private sanitizeForDisplay(text: string, maxLength: number = MAX_CONTENT_LENGTH_TOTAL): string {
    if (!text) return '';
    text = text.slice(0, maxLength);
    return text;
    // let result = '';
    // for (const ch of text) {
    //   const code = ch.codePointAt(0);
    //   if (code !== undefined && code > 0xffff) {
    //     const hex = code.toString(16).toUpperCase().padStart(4, '0');
    //     appendEventLog(`Unsupported character: U+${hex} (${ch})`);
    //     result += `*`;
    //   } else {
    //     result += ch;
    //   }
    // }
    // return result.length > 0 ? result.slice(0, maxLength) : ' ';
  }

  private async updateResearchDetailPage(research: Research): Promise<void> {
    if (!this.ui.researchPages.length) {
      const header = `${research.title}\n\n`;
      const full = header + research.content; // + footer;
      this.ui.researchPages = this.buildPages(full);
      this.ui.researchPageIndex = clamp(this.ui.researchPageIndex, 0, this.ui.researchPages.length - 1);
    }

    const rawPage = this.ui.researchPages[this.ui.researchPageIndex] ?? '';
    const page = this.sanitizeForDisplay(rawPage);

    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'finfotext',
        contentOffset: 0,
        contentLength: MAX_CONTENT_LENGTH_TOTAL,
        content: `[${this.ui.researchPageIndex + 1}/${this.ui.researchPages.length}][Scroll=read more][DTap=menu]`
      }),
    );

    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 2,
        containerName: 'research',
        contentOffset: 0,
        contentLength: MAX_CONTENT_LENGTH_TOTAL,
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
    try {
      localStorage.setItem(STORAGE_KEY_RESEARCHES, json);
    } catch {
      /* storage unavailable */
    }
  }

  private getDraftResearches(): Research[] {
    return this.state.researches.filter((r) => r.status === 'draft');
  }

  private getReadyResearches(): Research[] {
    return this.state.researches.filter((r) => r.status === 'ready');
  }

  private stopFullScreenTimer(): void {
    if (this.fullScreenTimerInterval != null) {
      window.clearInterval(this.fullScreenTimerInterval);
      this.fullScreenTimerInterval = null;
    }
    this.fullScreenTimerStartedAtMs = null;
  }

  /** Any full page rebuild invalidates the timer container — stop the interval first. */
  private async applyRebuildPageContainer(payload: RebuildPageContainer): Promise<boolean> {
    this.stopFullScreenTimer();
    return this.bridge.rebuildPageContainer(payload);
  }

  private async refreshFullScreenTimerLabel(): Promise<void> {
    if (this.fullScreenTimerStartedAtMs == null) return;
    const sec = Math.floor((Date.now() - this.fullScreenTimerStartedAtMs) / 1000);
    const label = formatElapsedMmSs(sec);
    try {
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: FULL_SCREEN_TIMER_CONTAINER_ID,
          containerName: 'ftimer',
          contentOffset: 0,
          contentLength: 32,
          content: label,
        }),
      );
    } catch {
      // View may have been replaced; interval will be cleared on next rebuild.
    }
  }

  private startFullScreenTimer(): void {
    this.stopFullScreenTimer();
    this.fullScreenTimerStartedAtMs = Date.now();
    this.fullScreenTimerInterval = window.setInterval(() => {
      void this.refreshFullScreenTimerLabel();
    }, 1000);
  }

  private async showTextFullScreen(content: string, infoText?: string): Promise<void> { // captureEvents = true
    const contentText = this.sanitizeForDisplay(content.slice(0, MAX_CONTENT_LENGTH));
    if (!infoText) { infoText = '...'; }
    const body = new TextContainerProperty({
      containerID: 1,
      containerName: 'body',
      xPosition: 10,
      yPosition: 32,
      width: 556,
      height: 255,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: contentText,
      isEventCapture: 1,
    });
    const infoTextOverlay = new TextContainerProperty({
      containerID: 2,
      containerName: 'finfotext',
      xPosition: 8,
      yPosition: 0,
      width: 556,
      height: 30,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 2,
      paddingLength: 1,
      content: infoText,
      isEventCapture: 0,
    });
    const success = await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [infoTextOverlay, body]
      }),
    );
    if (success) {
      setStatus(`Text: ${contentText} \n ${infoText}`);
    } else {
      appendEventLog(`Failed to show text full screen`);
    }
  }

  /**
   * Like `showTextFullScreen`, plus a top-left mm:ss timer (from 00:00) that updates every second.
   * The interval runs in parallel with other async work (e.g. network); timer ticks only send
   * `textContainerUpgrade` on the small timer container, not blocking your awaits elsewhere.
   */
  private async showTextFullScreenWithTimer(content: string, captureEvents = true): Promise<void> {
    const textBody = this.sanitizeForDisplay(content.slice(0, MAX_CONTENT_LENGTH));
    const timerOverlay = new TextContainerProperty({
      containerID: FULL_SCREEN_TIMER_CONTAINER_ID,
      containerName: 'ftimer',
      xPosition: 8,
      yPosition: 4,
      width: 86,
      height: 28,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: formatElapsedMmSs(0),
      isEventCapture: 0,
    });
    const body = new TextContainerProperty({
      containerID: 10,
      containerName: 'body',
      xPosition: 10,
      yPosition: 38,
      width: 556,
      height: 240,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: textBody,
      isEventCapture: captureEvents ? 1 : 0,
    });
    const success = await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [timerOverlay, body],
      }),
    );
    if (success) {
      setStatus(`Text: ${textBody}`);
      this.startFullScreenTimer();
    } else {
      appendEventLog(`Failed to show text full screen with timer`);
    }
  }

  /** Tear down live transcript listeners, speech recognition, debounce timer, and recording timer. */
  private clearVoicePromptRecordingUi(): void {
    this.stopFullScreenTimer();
    if (this.voicePromptTranscriptFlushTimer != null) {
      window.clearTimeout(this.voicePromptTranscriptFlushTimer);
      this.voicePromptTranscriptFlushTimer = null;
    }
    setSttLiveListener(null);
    this.stopVoicePromptInterimSpeechRecognition();
    this.voicePromptDurationLine = '';
  }

  private stopVoicePromptInterimSpeechRecognition(): void {
    if (this.voicePromptSpeechRec) {
      try {
        this.voicePromptSpeechRec.stop();
      } catch {
        try {
          this.voicePromptSpeechRec.abort?.();
        } catch {
          /* ignore */
        }
      }
      this.voicePromptSpeechRec = null;
    }
    this.voicePromptSrCommitted = '';
    this.voicePromptInterimFromSr = '';
  }

  /**
   * Best-effort browser speech recognition for interim captions (may be unavailable in embedded WebViews).
   * Final transcription still comes from ElevenLabs after stop.
   */
  private startVoicePromptInterimSpeechRecognition(): void {
    this.stopVoicePromptInterimSpeechRecognition();
    const g = globalThis as unknown as {
      SpeechRecognition?: new () => VoiceSpeechRecognition;
      webkitSpeechRecognition?: new () => VoiceSpeechRecognition;
    };
    const SR = g.SpeechRecognition ?? g.webkitSpeechRecognition;
    if (!SR) {
      appendEventLog('No speech recognition API found');
      this.voicePromptInterimFromSr = 'Speech recognition API not found';
      return;
    }

    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
    r.onresult = (ev: VoiceSpeechRecognitionEvent) => {
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const result = ev.results[i];
        const piece = result[0]?.transcript ?? '';
        if (result.isFinal) {
          this.voicePromptSrCommitted += piece;
        }
      }
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const result = ev.results[i];
        if (!result.isFinal) {
          interim += result[0]?.transcript ?? '';
        }
      }
      this.voicePromptInterimFromSr = `${this.voicePromptSrCommitted} ${interim}`.trim();
      this.scheduleVoicePromptTranscriptRefresh();
    };
    r.onerror = () => {
      /* missing mic / not allowed — ElevenLabs path still works */
    };
    try {
      r.start();
      this.voicePromptSpeechRec = r;
    } catch {
      this.voicePromptSpeechRec = null;
    }
  }

  private onVoicePromptSttLive(payload: SttLivePayload): void {
    if (payload.totalBytes <= 0) {
      this.voicePromptDurationLine = '';
    } else if (payload.totalBytes < 3200) {
      this.voicePromptDurationLine = 'Receiving audio…';
    } else {
      const sec = (payload.approxDurationMs / 1000).toFixed(1);
      this.voicePromptDurationLine = `~${sec}s buffered`;
    }
    this.scheduleVoicePromptTranscriptRefresh();
  }

  private scheduleVoicePromptTranscriptRefresh(): void {
    if (this.ui.view !== 'prompt-recording') return;
    if (this.voicePromptTranscriptFlushTimer != null) return;
    this.voicePromptTranscriptFlushTimer = window.setTimeout(() => {
      this.voicePromptTranscriptFlushTimer = null;
      void this.refreshVoicePromptTranscriptPanel();
    }, 320);
  }

  private composeVoicePromptTranscriptDisplay(): string {
    const lines: string[] = [];
    if (this.voicePromptInterimFromSr) {
      lines.push(this.voicePromptInterimFromSr);
    }
    if (this.voicePromptDurationLine) {
      lines.push(this.voicePromptDurationLine);
    }
    if (lines.length === 0) {
      return 'Interim transcript (when the browser supports it) and audio level appear here while you speak.';
    }
    return lines.join('\n\n');
  }

  private async refreshVoicePromptTranscriptPanel(): Promise<void> {
    if (this.ui.view !== 'prompt-recording') return;
    const text = this.sanitizeForDisplay(this.composeVoicePromptTranscriptDisplay(), MAX_CONTENT_LENGTH);
    try {
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: VOICE_PROMPT_TRANSCRIPT_CONTAINER_ID,
          containerName: 'vprompt-tr',
          contentOffset: 0,
          contentLength: MAX_CONTENT_LENGTH_TOTAL,
          content: text,
        }),
      );
    } catch {
      /* view replaced */
    }
  }

  /**
   * Voice prompt: hints + elapsed time + static context (title) + live-updating transcript panel.
   */
  private async showVoicePromptRecordingScreen(research: Research): Promise<void> {
    this.voicePromptDurationLine = '';
    this.voicePromptSrCommitted = '';
    this.voicePromptInterimFromSr = '';
    if (this.voicePromptTranscriptFlushTimer != null) {
      window.clearTimeout(this.voicePromptTranscriptFlushTimer);
      this.voicePromptTranscriptFlushTimer = null;
    }

    const title = this.sanitizeForDisplay(research.title,220);    

    const infoTextOverlay = new TextContainerProperty({
      containerID: VOICE_PROMPT_INFO_CONTAINER_ID,
      containerName: 'finfotext',
      xPosition: 8,
      yPosition: 0,
      width: 420,
      height: 32,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 2,
      paddingLength: 1,
      content: '[Tab=stop][DTab=cancel]',
      isEventCapture: 0,
    });
    const timerOverlay = new TextContainerProperty({
      containerID: FULL_SCREEN_TIMER_CONTAINER_ID,
      containerName: 'ftimer',
      xPosition: 432,
      yPosition: 0,
      width: 132,
      height: 32,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: formatElapsedMmSs(0),
      isEventCapture: 0,
    });
    const contextBlock = new TextContainerProperty({
      containerID: VOICE_PROMPT_CONTEXT_CONTAINER_ID,
      containerName: 'vprompt-ctx',
      xPosition: 10,
      yPosition: 35,
      width: 556,
      height: 80,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: this.sanitizeForDisplay(title,MAX_CONTENT_LENGTH),
      isEventCapture: 0,
    });
    const transcriptBlock = new TextContainerProperty({
      containerID: VOICE_PROMPT_TRANSCRIPT_CONTAINER_ID,
      containerName: 'vprompt-tr',
      xPosition: 10,
      yPosition: 115,
      width: 556,
      height: 173,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: this.sanitizeForDisplay(this.composeVoicePromptTranscriptDisplay(), MAX_CONTENT_LENGTH),
      isEventCapture: 1,
    });

    const success = await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 4,
        textObject: [infoTextOverlay, timerOverlay, contextBlock, transcriptBlock],
      }),
    );
    if (success) {
      setStatus(`Voice prompt: ${research.title.slice(0, 80)}…`);
      this.startFullScreenTimer();
    } else {
      appendEventLog('Failed to show voice prompt recording screen');
    }
  }

  private async renderMainMenu(): Promise<void> {

    const list = new ListContainerProperty({
      containerID: 9,
      containerName: 'app-menu',
      xPosition: 5,
      yPosition: 40,
      width: 560,
      height: 130,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 6,
      paddingLength: 0,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: 3,
        itemWidth: 550,
        isItemSelectBorderEn: 1,
        itemName: ['Start New Article Research', 'Continue Old Article Research', 'Review Ready for Publishing'],
      }),
    });

    const mainPage = new RebuildPageContainer({
      containerTotalNum: 4,
      textObject: [
        new TextContainerProperty({
          containerID: 1,
          containerName: 'menu-title',
          xPosition: 10,
          yPosition: 5,
          width: 300,
          height: 28,
          borderWidth: 0,
          borderColor: 5,
          paddingLength: 0,
          content: 'Article Publisher for WordPress',
          isEventCapture: 0,
        }),
        new TextContainerProperty({
          containerID: 2,
          containerName: 'menu-subtitle',
          xPosition: 10,
          yPosition: 220,
          width: 300,
          height: 56,
          borderWidth: 0,
          borderColor: 5,
          paddingLength: 0,
          content: '© 2026 Ivan Vlaevski  \nLicensed under the MIT License',
          isEventCapture: 0,
        }),
        new TextContainerProperty({
          containerID: 3,
          containerName: 'menu-footer',
          xPosition: 316,
          yPosition: 248,
          width: 250,
          height: 28,
          content: 'Revolute to @ivanvlaevski',
          isEventCapture: 0,
        }),
      ],
      listObject: [list],
    });

    const success = await this.applyRebuildPageContainer(mainPage);
    if (success) {
      this.ui.view = 'main-menu';
      setStatus('Main menu: tap to choose an option.');
    } else {
      appendEventLog(`Failed to create main menu`);
    }
  }

  private async renderNewResearchLoading(message: string): Promise<void> {
    this.ui.view = 'new-research-loading';
    this.ui.loadingMessage = message;
    await this.showTextFullScreenWithTimer(message);
  }

  private async renderTopicSelect(): Promise<void> {
    this.ui.view = 'topic-select';
    const topics = this.ui.topics;

    if (!topics.length) {
      await this.showTextFullScreen(
        'No topics defined on phone.\n\nUse the phone screen to add topics, then try again.',
        'Configuration error'
      );
      this.ui.view = 'error';
      return;
    }

    const items = topics.map((topic, index) => this.sanitizeForDisplay(`${index + 1}. ${topic}`,64));
    items.push('<- Back to main menu');

    const list = new ListContainerProperty({
      containerID: 8,
      containerName: 'topic-select',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    });

    await this.applyRebuildPageContainer(
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
      await this.showTextFullScreen('No results.', '[Tab=back]');
      return;
    }

    const maxItems = 3;
    const pageStart = Math.floor(this.ui.aiSelectedIndex / maxItems) * maxItems;
    const selectedSlot = this.ui.aiSelectedIndex - pageStart;
    const rowHeight = Math.floor(288 / maxItems);

    const textObjects: TextContainerProperty[] = [];
    for (let i = 0; i < maxItems; i += 1) {
      const index = pageStart + i;
      const item = this.ui.aiNews[index];
      const isSelected = index === this.ui.aiSelectedIndex;
      const label = item
        ? `${index + 1}. ${item.title.slice(0, 140)}`
        : '';

      textObjects.push(
        new TextContainerProperty({
          containerID: 4 + i,
          containerName: `aiitem${i}`,
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

    await this.applyRebuildPageContainer(
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

    const lines: string[] = [];
    lines.push(item.title);
    lines.push('');
    if (item.eventDateTime) lines.push(`Event: ${item.eventDateTime}`);
    if (item.sourceUrl) lines.push(`Source: ${item.sourceUrl}`);
    lines.push('');
    lines.push(item.description);
    lines.push('');
    //lines.push('Tap = Select and create research');
    //lines.push('Double-tap = Back to list');

    const content = this.sanitizeForDisplay(lines.join('\n'), MAX_CONTENT_LENGTH);
    await this.showTextFullScreen(content, '[Tab=select][DTab=back]');

    setStatus('Detail: tap to select, double-tap to go back to list.');
  }

  private async renderResearchList(): Promise<void> {
    const drafts = this.getDraftResearches();

    const items = drafts.map((r, idx) => this.sanitizeForDisplay(`${idx + 1}. ${r.title.slice(0, 60)}`,64));

    if (items.length > 19) {
      items.splice(19, items.length - 19);
      appendEventLog(`Research list truncated to 19 items`);
      setStatus(`Research list truncated to 19 items`);
    }
    items.push('<- Back');

    const list = new ListContainerProperty({
      containerID: 7,
      containerName: 'researchlist',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    });

    const success = await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        listObject: [list],
      }),
    );
    if (success) {
      setStatus('Draft researches: select a research or Back.');
      this.ui.view = 'research-list';
    } else {
      appendEventLog(`Failed to show research list`);
    }
  }

  private async renderResearchDetail(research: Research): Promise<void> {

    this.currentResearchId = research.id;
    const header = `${research.title}\n\n`;
    const full = header + research.content;
    this.ui.researchPages = this.buildPages(full);
    this.ui.researchPageIndex = 0;
    const textBody = this.sanitizeForDisplay(this.ui.researchPages[0] ?? '', MAX_CONTENT_LENGTH);

    const infoTextOverlay = new TextContainerProperty({
      containerID: 1,
      containerName: 'finfotext',
      xPosition: 8,
      yPosition: 0,
      width: 556,
      height: 30,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 2,
      paddingLength: 0,
      content: `[${this.ui.researchPageIndex + 1}/${this.ui.researchPages.length}][Scroll=read more][DTap=menu]`,
      isEventCapture: 0,
    });

    const contentText = textBody;
    const body = new TextContainerProperty({
      containerID: 2,
      containerName: 'research',
      xPosition: 10,
      yPosition: 32,
      width: 556,
      height: 255,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: contentText,
      isEventCapture: 1,
    });

    const success = await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [infoTextOverlay, body]
      }),
    );

    if (success) {
      setStatus('Research: scroll to read, double-tap for menu.');
      this.ui.view = 'research-detail';
    } else {
      appendEventLog(`Failed to show research detail`);
    }
  }

  private async renderReadyList(): Promise<void> {    
    const ready = this.getReadyResearches();
    const items = ready.map((r, idx) => `${idx + 1}. ${r.title.slice(0, 50)}`);
    if (items.length > 19) {
      items.splice(19, items.length - 19);
      appendEventLog(`Ready list truncated to 19 items`);
      setStatus(`Ready list truncated to 19 items`);
    }
    items.push('<- Back');

    const list = new ListContainerProperty({
      containerID: 9,
      containerName: 'readylist',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    });

    const success = await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        listObject: [list],
      }),
    );
    if (success) {
      setStatus('Ready for publishing: select a research or Back.');
      this.ui.view = 'ready-list';
    } else {
      appendEventLog(`Failed to show ready list`);
    }
  }

  private async renderReadyDetail(research: Research): Promise<void> {
    this.ui.view = 'ready-detail';
    this.currentResearchId = research.id;
    const delay = clamp(this.ui.promptDelayDays, 0, 10);
    const header = `${research.title}\n\nPublish delay (days): ${delay}\n\n`;
    //const footer = '\n\nDouble-tap for menu';

    const full = header + research.content; // + footer;
    this.ui.readyPages = this.buildPages(full);
    this.ui.readyPageIndex = 0;
    const contentText = this.sanitizeForDisplay(this.ui.readyPages[0] ?? '', MAX_CONTENT_LENGTH);

    const infoTextOverlay = new TextContainerProperty({
      containerID: 1,
      containerName: 'finfotext',
      xPosition: 8,
      yPosition: 0,
      width: 556,
      height: 30,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 2,
      paddingLength: 0,
      content: `[${this.ui.readyPageIndex + 1}/${this.ui.readyPages.length}][Scroll=read more][DTap=menu]`,
      isEventCapture: 0,
    });

    const body = new TextContainerProperty({
      containerID: 2,
      containerName: 'readydetail',
      xPosition: 10,
      yPosition: 32,
      width: 556,
      height: 255,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: contentText,
      isEventCapture: 1,
    });

    await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [infoTextOverlay, body]
      }),
    );
  }

  private async updateReadyDelayText(research: Research): Promise<void> {
    const delay = clamp(this.ui.promptDelayDays, 0, 10);
    const header = `${research.title}\n\n`;
    const full = header + research.content;
    this.ui.readyPages = this.buildPages(full);
    this.ui.readyPageIndex = clamp(this.ui.readyPageIndex, 0, this.ui.readyPages.length - 1);
    const rawPage = this.ui.readyPages[this.ui.readyPageIndex] ?? '';
    const page = this.sanitizeForDisplay(rawPage);

    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'finfotext',
        contentOffset: 0,
        contentLength: MAX_CONTENT_LENGTH_TOTAL,
        content: `[${this.ui.readyPageIndex + 1}/${this.ui.readyPages.length}][Scroll=read more][DTap=menu]`,
      }),
    );

    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 2,
        containerName: 'readydetail',
        contentOffset: 0,
        contentLength: MAX_CONTENT_LENGTH_TOTAL,
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
    if (!config.googleGenerativeApiKey?.trim()) {
      await this.showTextFullScreen(
        'Google Gemini API key missing.\n\nSet it under AI & Publishing Settings on the phone, then try again.',
        'Configuration error'
      );
      return;
    }

    this.ui.topics = loadTopicsFromLocalStorage();
    if (this.ui.topics.length > 0 && !this.ui.selectedTopic) {
      await this.renderTopicSelect();
      return;
    }

    const topic = (this.ui.selectedTopic ?? 'Artificial Intelligence').trim();

    await this.renderNewResearchLoading(`Finding the 10 most recent and discussion-worthy developments about ${topic}. Focus on events from the last 30 days. Search priority on official website, newsroom, blog, press release pages, official social accounts, reposts and reactions on social media.`);

    try {
      this.ui.aiNews = await fetchLatestAiNews(config, topic);
      this.ui.aiSelectedIndex = 0;
      this.ui.selectedTopic = null;
      appendEventLog(`Fetched ${this.ui.aiNews.length} news items for "${topic}"`);
      await this.renderAiNewsList();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.showTextFullScreen(`Failed to fetch AI news.\n\n${message}`, '[Tab=back]');
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
        'Configuration error'
      );
      return;
    }

    await this.renderNewResearchLoading('Creating article draft…');

    const title = item.title || 'Article (draft)';
    let content: string;
    try {
      content = await elaborateResearch(config, item, title);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.showTextFullScreen(`Failed to elaborate research.\n\n${message}`, '[Tab=back]');
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
    if (this.ui.researchSelectedIndex < 0) {
      this.ui.researchSelectedIndex = Math.max(0, this.getDraftResearches().length - 1);
    }
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

  /** Phone UI: reload from bridge and return all researches (draft + ready). */
  public async getResearchesForPhoneUi(): Promise<Research[]> {
    await this.loadResearches();
    return this.state.researches.slice();
  }

  /** Phone UI: remove one research by id (draft or ready). */
  public async deleteResearchByIdFromPhone(id: string): Promise<boolean> {
    await this.loadResearches();
    const idx = this.state.researches.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    if (this.currentResearchId === id) {
      this.currentResearchId = null;
    }
    const [removed] = this.state.researches.splice(idx, 1);
    await this.saveResearches();
    appendEventLog(`Deleted research from phone: "${removed?.title ?? id}"`);
    return true;
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
        'Configuration error'
      );
      return;
    }

    try {
      setStatus('Updating research with AI prompt…');
      appendEventLog(`Applying prompt to research "${research.title}"`);
      await this.showTextFullScreenWithTimer(
        `Applying prompt…\n\n"${research.title}"\n\nPlease wait.`,
        false,
      );
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
      } else if (updated.status === 'ready') {
        await this.renderReadyDetail(updated);
      } else {
        await this.renderResearchDetail(updated);
      }

      setStatus('Research updated from prompt.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.showTextFullScreen(
        `Failed to apply prompt to research.\n\n${message}`, '[Tab=back]'
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
      await this.showTextFullScreen(`Failed to publish.\n\n${message}`, '[Tab=back]');
      this.ui.view = 'error';
    }
  }

  private async openReadyMenu(research: Research): Promise<void> {
    this.ui.view = 'ready-menu';

    const items = ['Publish now', 'Cancel publishing', 'Back to ready list', 'Back to main menu'];

    const list = new ListContainerProperty({
      containerID: 9,
      containerName: 'readymenu',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    });

    await this.applyRebuildPageContainer(
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
      containerID: isReady ? 9 : 8,
      containerName: isReady ? 'cancelready' : 'cancelresearch',
      xPosition: 0,
      yPosition: 200,
      width: 576,
      height: 80,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 1,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items.map((label, idx) => `${idx + 1}. ${label}`),
      }),
    });

    const questionText = this.sanitizeForDisplay(question);

    await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [
          new TextContainerProperty({
            containerID: isReady ? 1 : 2,
            containerName: isReady ? 'cancelrtext' : 'cancelstext',
            xPosition: 0,
            yPosition: 0,
            width: 576,
            height: 200,
            borderWidth: 0,
            borderColor: 5,
            borderRadius: 0,
            paddingLength: 4,
            content: questionText,
            isEventCapture: 0,
          }),
        ],
        listObject: [list],
      }),
    );

    setStatus(isReady ? 'Confirm cancel publishing (Yes / No).' : 'Confirm cancel research (Yes / No).');
  }

  private async openResearchMenu(research: Research): Promise<void> {

    const items = [
      'Read aloud (Unlock & test phone speaker first)',
      'Record Voice Prompt to refine research',
      'Mark as Ready for Publish',
      'Cancel research',
      'Back to draft list',
      'Back to main menu',
    ];

    const list = new ListContainerProperty({
      containerID: 9,
      containerName: 'researchmenu',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    });

    const success = await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        listObject: [list],
      }),
    );

    if (success) {
      setStatus('Research menu: select an action.');
      this.ui.view = 'research-menu';
    } else {
      appendEventLog(`Failed to show research menu`);
    }
  }

  private async startReadAloud(research: Research): Promise<void> {
    const config = this.getConfig();
    if (!config.elevenLabsApiKey?.trim()) {
      await this.showTextFullScreen(
        `${research.title}\n\n` +
        'ElevenLabs API key missing.\n\nSet the key on the phone screen, then try again.',
        '[Tab=back]'
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

    const contentText = this.sanitizeForDisplay(`${line}`);

    const infoTextOverlay = new TextContainerProperty({
      containerID: 1,
      containerName: 'finfotext',
      xPosition: 8,
      yPosition: 0,
      width: 556,
      height: 30,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 2,
      paddingLength: 0,
      content: '[Tap=pause][Down=next line][Up=replay][DTap=back]',
      isEventCapture: 0,
    });
    const body = new TextContainerProperty({
      containerID: 2,
      containerName: 'readaloud',
      xPosition: 10,
      yPosition: 32,
      width: 556,
      height: 255,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: contentText,
      isEventCapture: 1,
    });

    await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [
          infoTextOverlay, body]
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
    revokeSharedPlaybackBlobUrl();
    await this.renderResearchDetail(research);
  }

  private playLineAsAudio(config: PublisherConfig, line: string, research: Research): Promise<void> {
    return new Promise((resolve, reject) => {
      this.currentLineToRead = line;
      synthesizeSpeech(config, line)
        .then((arrayBuffer) => {
          if (this.readAloudAborted) {
            appendEventLog(`Read aloud aborted`);
            resolve();
            return;
          }
          if (this.currentLineToRead !== line) {
            appendEventLog(`Read aloud current line changed`);
            resolve();
            return;
          }
          const audio = prepareSharedPlaybackFromMp3(arrayBuffer);
          this.currentReadAloudAudio = audio;
          audio.onended = () => {
            revokeSharedPlaybackBlobUrl();
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
            revokeSharedPlaybackBlobUrl();
            this.currentReadAloudAudio = null;
            reject(audio.error ?? new Error('Playback failed'));
            setStatus('Read aloud: audio ERROR');
          };
          void audio.play().catch((err) => {
            revokeSharedPlaybackBlobUrl();
            this.currentReadAloudAudio = null;
            const msg = err instanceof Error ? err.message : String(err);
            setStatus(
              `Read aloud: ${msg}\n\nOn the phone, tap “Unlock & test phone speaker” first (iOS/Android autoplay).`,
            );
            reject(err instanceof Error ? err : new Error(msg));
          });
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
        '[Tab=back]'
      );
      return;
    }

    if (!this.isVoiceRecording) {
      try {
        this.ui.view = 'prompt-recording';
        await this.showVoicePromptRecordingScreen(research);
        setSttLiveListener((p) => this.onVoicePromptSttLive(p));
        this.startVoicePromptInterimSpeechRecognition();
        await startSttRecording(this.bridge);
        this.isVoiceRecording = true;
        setStatus('Voice prompt: listening…');
      } catch (error) {
        this.clearVoicePromptRecordingUi();
        const message = error instanceof Error ? error.message : String(error);
        await this.showTextFullScreen(
          `${research.title}\n\nFailed to start voice prompt.\n\n${message}`,
          '[Tab=back]'
        );
      }
      return;
    }

    try {
      this.clearVoicePromptRecordingUi();
      const transcript = await stopSttAndTranscribe(config.elevenLabsApiKey);
      this.isVoiceRecording = false;

      setStatus(`Voice prompt: ${transcript}`);

      if (!transcript.trim()) {
        await this.showTextFullScreen(
          `${research.title}\n\nNo speech captured.\n\nSpeak for a bit longer and try again.`,
          '[Tab=back]'
        );
        return;
      }

      try {
        localStorage.setItem('article-publisher:last-transcript', transcript);
      } catch {
        // ignore storage errors
      }

      await this.applyPromptToCurrentResearch(transcript);

      // await this.showTextFullScreen(
      //   `${research.title}\n\n` +
      //   'Transcribed request:\n\n' +
      //   `${transcript}\n\n` +
      //   'You can now use this text to refine the draft on the phone.',
      // );
    } catch (error) {
      this.isVoiceRecording = false;
      const message = error instanceof Error ? error.message : String(error);
      await this.showTextFullScreen(
        `${research.title}\n\nFailed to transcribe speech.\n\n${message}`,
        '[Tab=back]'
      );
    }
  }

  /**
   * Glass firmware may use different casing / underscores for text container names.
   */
  // private normalizeContainerName(name: string): string {
  //   return name.replace(/_/g, '-').toLowerCase().trim();
  // }

  // private textContainerNameMatches(
  //   got: string | undefined,
  //   expected: string,
  // ): boolean {
  //   if (got == null || got === '') return false;
  //   return this.normalizeContainerName(got) === this.normalizeContainerName(expected);
  // }

  /**
   * `evenHubEventFromJson` can drop `listEvent` when the host uses alternate keys
   * (`list_event`, nested `jsonData`). Merge loose payloads so list taps (main menu, etc.) work.
   */
  private normalizeIncomingHubEvent(raw: unknown): EvenHubEvent {
    const parsed = evenHubEventFromJson(raw);
    if (raw === null || typeof raw !== 'object') return parsed;

    const r = raw as Record<string, unknown>;
    const jd = (r.jsonData ?? r.json_data) as Record<string, unknown> | undefined;

    let listEvent = parsed.listEvent;
    if (!listEvent) {
      const rawList = r.listEvent ?? r.list_event ?? jd?.listEvent ?? jd?.list_event;
      if (rawList != null && typeof rawList === 'object') {
        try {
          listEvent = List_ItemEvent.fromJson(rawList);
        } catch {
          listEvent = rawList as EvenHubEvent['listEvent'];
        }
      }
    }

    let textEvent = parsed.textEvent;
    if (!textEvent) {
      const rawText = r.textEvent ?? r.text_event ?? jd?.textEvent ?? jd?.text_event;
      if (rawText != null && typeof rawText === 'object') {
        try {
          textEvent = Text_ItemEvent.fromJson(rawText);
        } catch {
          textEvent = rawText as EvenHubEvent['textEvent'];
        }
      }
    }

    let sysEvent = parsed.sysEvent;
    if (!sysEvent) {
      const rawSys = r.sysEvent ?? r.sys_event ?? jd?.sysEvent ?? jd?.sys_event;
      if (rawSys != null && typeof rawSys === 'object') {
        try {
          sysEvent = Sys_ItemEvent.fromJson(rawSys);
        } catch {
          sysEvent = rawSys as EvenHubEvent['sysEvent'];
        }
      }
    }

    let audioEvent = parsed.audioEvent;
    if (!audioEvent?.audioPcm) {
      const rawAudio = r.audioEvent ?? r.audio_event ?? jd?.audioEvent ?? jd?.audio_event;
      if (rawAudio != null && typeof rawAudio === 'object') {
        const ra = rawAudio as Record<string, unknown>;
        const nestedPcm = ra.audioPcm ?? ra.audio_pcm;
        if (nestedPcm != null) {
          audioEvent = {
            ...audioEvent,
            audioPcm: nestedPcm as NonNullable<EvenHubEvent['audioEvent']>['audioPcm'],
          };
        } else {
          audioEvent = rawAudio as EvenHubEvent['audioEvent'];
        }
      }
    }
    if (!audioEvent?.audioPcm) {
      const loosePcm = r.audioPcm ?? r.audio_pcm ?? jd?.audioPcm ?? jd?.audio_pcm;
      if (loosePcm != null) {
        audioEvent = {
          ...audioEvent,
          audioPcm: loosePcm as NonNullable<EvenHubEvent['audioEvent']>['audioPcm'],
        };
      }
    }

    return {
      ...parsed,
      listEvent,
      textEvent,
      sysEvent,
      audioEvent,
    };
  }

  private async onEvenHubEvent(event: EvenHubEvent): Promise<void> {
    const hubPcm = event.audioEvent?.audioPcm as Uint8Array | number[] | string | undefined;
    if (hubPcm != null && hubPcm !== '') {
      feedSttAudio(hubPcm);
    }

    // Do not return after audio: the host may attach audio alongside list events, or send
    // empty PCM; swallowing the whole event here broke main-menu (and other) list taps.

    if (!event.textEvent && !event.listEvent && !event.sysEvent) {
      return;
    }

    const eventType =
      event.textEvent?.eventType ??
      event.sysEvent?.eventType ??
      event.listEvent?.eventType ??
      undefined;

    // Must be gated by view: unguarded `app-menu` was stealing taps from other list screens.
    if (this.ui.view === 'main-menu' && event.listEvent) {
      const listGesture =
        OsEventTypeList.fromJson(event.listEvent.eventType) ??
        OsEventTypeList.fromJson(eventType) ??
        eventType;
      if (
        listGesture === OsEventTypeList.SCROLL_TOP_EVENT ||
        listGesture === OsEventTypeList.SCROLL_BOTTOM_EVENT
      ) {
        return;
      }
      const idx = event.listEvent.currentSelectItemIndex ?? 0;
      await this.handleMainMenuSelect(idx);
      return;
    }

    if (this.ui.view === 'topic-select' && event.listEvent) {
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

    if (this.ui.view === 'research-list') {
      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        const drafts = this.getDraftResearches();
        const idx = event.listEvent?.currentSelectItemIndex ?? 0;
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
    //    this.textContainerNameMatches(event.textEvent.containerName, 'research'))
    if (this.ui.view === 'research-detail') {
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

    if (this.ui.view === 'research-menu' && event.listEvent) {
      const drafts = this.getDraftResearches();
      const research = drafts[this.ui.researchSelectedIndex];
      if (!research) {
        await this.renderResearchList();
        return;
      }

      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        if (idx === 0) {
          if (!hasPhonePlaybackPrimedThisSession()) {
            this.ui.view = 'research-read-aloud-unlock-hint';
            await this.showTextFullScreen(
              "Please, open your phone and click once on button 'Unlock & test phone speaker first' to enable audio.",
              '[Tab=back]',
            );
            return;
          }
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
            setStatus('Read aloud resumed. Tap to pause or double-tap to exit.');
            this.currentReadAloudAudio.play().catch((err) => {
              setStatus(
                `Read aloud: ${err instanceof Error ? err.message : String(err)}\n\nOn the phone, tap “Unlock & test phone speaker” first (iOS/Android autoplay).`,
              );
            });
          } else {
            this.currentReadAloudAudio.pause();
            setStatus('Read aloud paused. Tap to continue or double-tap to exit.');
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
          return;
        }
        await this.renderResearchDetail(research);
        return;
      }

      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        if (this.isVoiceRecording) {
          await cancelSttRecording();
          this.isVoiceRecording = false;
          this.clearVoicePromptRecordingUi();
        }
        await this.renderResearchDetail(research);
        return;
      }
    }

    if (this.ui.view === 'ready-list' && event.listEvent) {
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
      // if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
      //   //this.ui.promptDelayDays = clamp(this.ui.promptDelayDays + 1, 0, 10);
      //   await this.updateReadyDelayText(research);
      //   return;
      // }

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

    if (this.ui.view === 'ready-menu' && event.listEvent) {
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
      (this.ui.view === 'confirm-cancel-research' && event.listEvent) ||
      (this.ui.view === 'confirm-cancel-ready' && event.listEvent)
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

    if (this.ui.view === 'research-read-aloud-unlock-hint') {
      const drafts = this.getDraftResearches();
      const research = drafts[this.ui.researchSelectedIndex];
      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        if (research) {
          await this.renderResearchDetail(research);
        } else {
          await this.renderResearchList();
        }
      }
      return;
    }

    if (this.ui.view === 'error') {
      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        await this.renderMainMenu();
      }
    }
  }
}

