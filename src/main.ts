import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk';

import { EvenPublisherClient } from './even-client';
import type { Research } from './types';
import {
  PHONE_AUDIO_INPUT_KEY,
  PHONE_AUDIO_OUTPUT_KEY,
  phoneAudioOutputSupportsSink,
  primeSharedPlaybackAudioFromUserGesture,
  setPhoneAudioStorageBridge,
} from './phone-audio';
import {
  appendEventLog,
  installGlobalErrorLogging,
  loadConfigFromLocalStorage,
  saveConfigToLocalStorage,
  setStatus,
  loadTopicsFromLocalStorage,
  saveTopicsToLocalStorage,
} from './utils';

let client: EvenPublisherClient | null = null;
let statusTimer: number | null = null;
let storageBridge: EvenAppBridge | null = null;
let settingsUiWired = false;
let refreshSettingsUiFromStorage: (() => Promise<void>) | null = null;

const NO_RESEARCH_ON_GLASSES = 'No research selected on glasses.';

const RESEARCHES_STORAGE_KEY = 'article-publisher:researches';
let readAloudStartBannerDismissed = false;

async function getStorageValue(key: string): Promise<string> {
  if (storageBridge) return (await storageBridge.getLocalStorage(key)) ?? '';
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

async function setStorageValue(key: string, value: string): Promise<void> {
  if (storageBridge) {
    await storageBridge.setLocalStorage(key, value);
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore storage errors */
  }
}

declare global {
  interface Window {
    __evenPublisherRefreshResearchLists?: () => void;
  }
}

async function loadResearchesForPhoneLists(): Promise<Research[]> {
  if (client) {
    return client.getResearchesForPhoneUi();
  }
  try {
    const raw = await getStorageValue(RESEARCHES_STORAGE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as Research[]) : [];
  } catch {
    return [];
  }
}

async function deleteResearchEntryFromPhone(id: string): Promise<void> {
  if (client) {
    await client.deleteResearchByIdFromPhone(id);
    const fn = (window as unknown as { __evenPublisherUpdateResearchStatus?: (c: EvenPublisherClient | null) => void })
      .__evenPublisherUpdateResearchStatus;
    fn?.(client);
    return;
  }
  const list = await loadResearchesForPhoneLists();
  const next = list.filter((r) => r.id !== id);
  await setStorageValue(RESEARCHES_STORAGE_KEY, JSON.stringify(next));
  appendEventLog('Research removed from browser storage only — connect glasses to sync with G2.');
}

const AI_SETTINGS_INPUT_IDS = [
  'google-generative-key',
  'openai-key',
  'openai-model',
  'elevenlabs-key',
  'wp-url',
  'wp-username',
  'wp-password',
] as const;

function allAiSettingsFieldsFilled(): boolean {
  return AI_SETTINGS_INPUT_IDS.every((id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    return el != null && el.value.trim().length > 0;
  });
}

async function runPhoneAudioUnlockFromUserClick(): Promise<void> {
  try {
    const htmlOk = await primeSharedPlaybackAudioFromUserGesture();
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) {
      const ctx = new AC();
      await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.07;
      osc.type = 'sine';
      osc.frequency.value = 880;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    }
    if (htmlOk) {
      setStatus(
        'Phone audio: unlock OK — read aloud uses this same speaker path (tap here again if playback stops working).',
      );
      appendEventLog('Phone audio: HTMLAudioElement + Web Audio unlock OK.');
    } else {
      setStatus(
        'Phone audio: Web Audio OK, but HTMLAudioElement silent clip was blocked — try again or check browser permissions.',
      );
      appendEventLog('Phone audio: HTMLAudioElement prime failed (read aloud may still block).');
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    setStatus(`Phone audio test: ${m}`);
    appendEventLog(`Phone audio test failed: ${m}`);
  }
}

function bootReadAloudStartBanner(): void {
  const section = document.getElementById('phone-audio-start-banner');
  const unlockStart = document.getElementById('audio-unlock-test-start') as HTMLButtonElement | null;
  const dismissBtn = document.getElementById('phone-audio-start-banner-dismiss') as HTMLButtonElement | null;
  if (!section || !unlockStart || !dismissBtn) return;

  if (readAloudStartBannerDismissed) {
    section.setAttribute('hidden', '');
  } else {
    section.removeAttribute('hidden');
  }

  unlockStart.addEventListener('click', () => {
    void runPhoneAudioUnlockFromUserClick();
    readAloudStartBannerDismissed = true;
    section.setAttribute('hidden', '');
  });

  dismissBtn.addEventListener('click', () => {
    readAloudStartBannerDismissed = true;
    section.setAttribute('hidden', '');
  });
}

function bootPhoneAudioUi(): void {
  const infoEl = document.getElementById('audio-device-info');
  const outputSel = document.getElementById('audio-output-select') as HTMLSelectElement | null;
  const inputSel = document.getElementById('audio-input-select') as HTMLSelectElement | null;
  const unlockBtn = document.getElementById('audio-unlock-test') as HTMLButtonElement | null;
  const refreshBtn = document.getElementById('audio-refresh-devices') as HTMLButtonElement | null;
  const sinkNote = document.getElementById('audio-sink-support-note');

  if (!infoEl || !outputSel || !inputSel || !unlockBtn || !refreshBtn) return;

  if (sinkNote) {
    sinkNote.textContent = phoneAudioOutputSupportsSink()
      ? 'Output selection is supported here. '
      : 'Output device picker not supported in this browser — playback uses the system default. ';
  }

  const refreshAudioDeviceUi = async (): Promise<void> => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      infoEl.textContent =
        'navigator.mediaDevices is unavailable in this WebView — cannot list inputs/outputs.';
      return;
    }

    let list = await navigator.mediaDevices.enumerateDevices();

    const needLabels = list.some((d) => !d.label);
    if (needLabels) {
      infoEl.textContent =
        'Requesting one-time microphone access so the browser can show device names (phone mic, not G2)…';
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        list = await navigator.mediaDevices.enumerateDevices();
      } catch {
        infoEl.textContent =
          'Permission denied or unavailable — listing devices without friendly names.';
      }
    }

    const lines = list.map(
      (d) => `${d.kind}: ${d.label || '(no label)'} — ${d.deviceId.slice(0, 16)}…`,
    );
    infoEl.textContent = lines.length ? lines.join('\n') : 'No media devices reported.';

    const savedOut = await getStorageValue(PHONE_AUDIO_OUTPUT_KEY);
    const savedIn = await getStorageValue(PHONE_AUDIO_INPUT_KEY);

    if (phoneAudioOutputSupportsSink()) {
      outputSel.disabled = false;
      const outs = list.filter((d) => d.kind === 'audiooutput');
      outputSel.innerHTML = '<option value="">Default (system routing)</option>';
      for (const d of outs) {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Output ${d.deviceId.slice(0, 8)}…`;
        outputSel.appendChild(opt);
      }
      outputSel.value = outs.some((d) => d.deviceId === savedOut) ? savedOut : '';
    } else {
      outputSel.disabled = true;
      outputSel.innerHTML =
        '<option value="">System default (no setSinkId in this browser)</option>';
    }

    const ins = list.filter((d) => d.kind === 'audioinput');
    inputSel.innerHTML =
      '<option value="">(Informational — G2 uses glasses mic for STT)</option>';
    for (const d of ins) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}…`;
      inputSel.appendChild(opt);
    }
    inputSel.value = ins.some((d) => d.deviceId === savedIn) ? savedIn : '';
  };

  outputSel.addEventListener('change', () => {
    const v = outputSel.value.trim();
    void (async () => {
      await setStorageValue(PHONE_AUDIO_OUTPUT_KEY, v);
      appendEventLog(`Phone audio: playback output ${v ? 'set' : 'cleared (system default)'}.`);
    })();
  });

  inputSel.addEventListener('change', () => {
    const v = inputSel.value.trim();
    void (async () => {
      await setStorageValue(PHONE_AUDIO_INPUT_KEY, v);
      appendEventLog(`Phone audio: stored mic selection (informational).`);
    })();
  });

  unlockBtn.addEventListener('click', () => {
    void runPhoneAudioUnlockFromUserClick();
  });

  refreshBtn.addEventListener('click', () => {
    void refreshAudioDeviceUi();
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      void refreshAudioDeviceUi();
    });
  }

  void refreshAudioDeviceUi();
}

function bootResearchPhoneLists(): void {
  const draftUl = document.getElementById('draft-researches-list');
  const readyUl = document.getElementById('ready-researches-list');
  const draftEmpty = document.getElementById('draft-researches-empty');
  const readyEmpty = document.getElementById('ready-researches-empty');
  const refreshBtn = document.getElementById('research-lists-refresh');

  if (!draftUl || !readyUl) return;

  const render = async (): Promise<void> => {
    const all = await loadResearchesForPhoneLists();
    const drafts = all.filter((r) => r.status === 'draft');
    const ready = all.filter((r) => r.status === 'ready');

    draftUl.innerHTML = '';
    for (const r of drafts) {
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'research-item-title';
      title.title = r.title;
      title.textContent = r.title || '(untitled)';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-ghost research-delete';
      del.dataset.researchId = r.id;
      del.textContent = 'Delete';
      li.append(title, del);
      draftUl.appendChild(li);
    }
    if (draftEmpty) draftEmpty.hidden = drafts.length > 0;

    readyUl.innerHTML = '';
    for (const r of ready) {
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'research-item-title';
      title.title = r.title;
      title.textContent = r.title || '(untitled)';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-ghost research-delete';
      del.dataset.researchId = r.id;
      del.textContent = 'Delete';
      li.append(title, del);
      readyUl.appendChild(li);
    }
    if (readyEmpty) readyEmpty.hidden = ready.length > 0;
  };

  const wireDelete = (ul: HTMLElement, message: string): void => {
    ul.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('button[data-research-id]') as HTMLButtonElement | null;
      if (!btn || !ul.contains(btn)) return;
      const id = btn.dataset.researchId;
      if (!id) return;
      if (!window.confirm(message)) return;
      void deleteResearchEntryFromPhone(id)
        .then(() => render())
        .catch((err) => {
          const m = err instanceof Error ? err.message : String(err);
          appendEventLog(`Delete research failed: ${m}`);
          setStatus(`Delete failed: ${m}`);
        });
    });
  };

  wireDelete(draftUl, 'Delete this draft? It will be removed from the glasses list too when synced.');
  wireDelete(
    readyUl,
    'Remove this ready item? It will be removed from the publishing queue when synced.',
  );

  refreshBtn?.addEventListener('click', () => {
    void render();
  });

  window.__evenPublisherRefreshResearchLists = () => {
    void render();
  };

  void render();
}

async function bootSettingsUi(): Promise<void> {
  const googleGenerativeKeyInput = document.getElementById('google-generative-key') as HTMLInputElement | null;
  const openAiKeyInput = document.getElementById('openai-key') as HTMLInputElement | null;
  const openAiModelInput = document.getElementById('openai-model') as HTMLInputElement | null;
  const elevenLabsKeyInput = document.getElementById('elevenlabs-key') as HTMLInputElement | null;
  const wpUrlInput = document.getElementById('wp-url') as HTMLInputElement | null;
  const wpUserInput = document.getElementById('wp-username') as HTMLInputElement | null;
  const wpPassInput = document.getElementById('wp-password') as HTMLInputElement | null;
  const saveBtn = document.getElementById('save-settings') as HTMLButtonElement | null;
  const researchStatus = document.getElementById('research-status') as HTMLDivElement | null;
  const promptTextarea = document.getElementById('prompt-text') as HTMLTextAreaElement | null;
  const promptSubmitBtn = document.getElementById('prompt-submit') as HTMLButtonElement | null;
  const useTranscriptBtn = document.getElementById('use-transcript') as HTMLButtonElement | null;
  const topicsListEl = document.getElementById('topics-list') as HTMLUListElement | null;
  const newTopicInput = document.getElementById('new-topic') as HTMLInputElement | null;
  const topicsAddBtn = document.getElementById('topics-add') as HTMLButtonElement | null;
  const topicsDeleteBtn = document.getElementById('topics-delete') as HTMLButtonElement | null;
  const topicsSaveBtn = document.getElementById('topics-save') as HTMLButtonElement | null;

  const aiSettingsSummary = document.getElementById('ai-settings-summary');
  const aiSettingsBody = document.getElementById('ai-settings-body');
  const aiSettingsShowBtn = document.getElementById('ai-settings-show') as HTMLButtonElement | null;
  const aiSettingsHideBtn = document.getElementById('ai-settings-hide') as HTMLButtonElement | null;

  let aiSettingsExpanded = !allAiSettingsFieldsFilled();

  const syncAiSettingsPanel = (): void => {
    if (!aiSettingsSummary || !aiSettingsBody || !aiSettingsHideBtn) return;
    const filled = allAiSettingsFieldsFilled();
    const collapsed = filled && !aiSettingsExpanded;
    aiSettingsSummary.hidden = !collapsed;
    aiSettingsBody.hidden = collapsed;
    aiSettingsHideBtn.hidden = collapsed || !filled;
  };

  syncAiSettingsPanel();

  aiSettingsShowBtn?.addEventListener('click', () => {
    aiSettingsExpanded = true;
    syncAiSettingsPanel();
  });

  aiSettingsHideBtn?.addEventListener('click', () => {
    aiSettingsExpanded = false;
    syncAiSettingsPanel();
  });

  for (const id of AI_SETTINGS_INPUT_IDS) {
    document.getElementById(id)?.addEventListener('input', () => {
      if (!allAiSettingsFieldsFilled()) {
        aiSettingsExpanded = true;
      }
      syncAiSettingsPanel();
    });
  }

  let topics: string[] = [];

  const renderTopicsList = () => {
    if (!topicsListEl) return;
    topicsListEl.innerHTML = '';
    topics.forEach((topic, index) => {
      const li = document.createElement('li');
      li.textContent = topic;
      li.dataset.index = String(index);
      li.addEventListener('click', () => {
        if (!topicsListEl) return;
        const children = Array.from(topicsListEl.querySelectorAll('li'));
        children.forEach((child) => child.classList.remove('selected'));
        li.classList.add('selected');
      });
      topicsListEl.appendChild(li);
    });
  };

  const reloadFromStorage = async (): Promise<void> => {
    const config = await loadConfigFromLocalStorage(storageBridge);
    if (googleGenerativeKeyInput) googleGenerativeKeyInput.value = config.googleGenerativeApiKey;
    if (openAiKeyInput) openAiKeyInput.value = config.openAiApiKey;
    if (openAiModelInput) openAiModelInput.value = config.openAiModel;
    if (elevenLabsKeyInput) elevenLabsKeyInput.value = config.elevenLabsApiKey;
    if (wpUrlInput) wpUrlInput.value = config.wordpressBaseUrl;
    if (wpUserInput) wpUserInput.value = config.wordpressUsername;
    if (wpPassInput) wpPassInput.value = config.wordpressPassword;
    topics = await loadTopicsFromLocalStorage(storageBridge);
    renderTopicsList();
    syncAiSettingsPanel();
  };

  refreshSettingsUiFromStorage = reloadFromStorage;

  if (settingsUiWired) {
    await reloadFromStorage();
    return;
  }

  settingsUiWired = true;

  saveBtn?.addEventListener('click', () => {
    const next = {
      googleGenerativeApiKey: googleGenerativeKeyInput?.value ?? '',
      openAiApiKey: openAiKeyInput?.value ?? '',
      openAiModel: openAiModelInput?.value ?? 'gpt-4.1-mini',
      elevenLabsApiKey: elevenLabsKeyInput?.value ?? '',
      wordpressBaseUrl: wpUrlInput?.value ?? '',
      wordpressUsername: wpUserInput?.value ?? '',
      wordpressPassword: wpPassInput?.value ?? '',
    };
    void (async () => {
      await saveConfigToLocalStorage(storageBridge, next);
      appendEventLog('Settings saved.');
      setStatus('Settings saved. You can now start a new research from glasses.');
      if (allAiSettingsFieldsFilled()) {
        aiSettingsExpanded = false;
        syncAiSettingsPanel();
      }
    })();
  });

  topicsAddBtn?.addEventListener('click', () => {
    const value = newTopicInput?.value.trim() ?? '';
    if (!value) {
      setStatus('Topic is empty. Type a name first.');
      return;
    }
    if (!topics.includes(value)) {
      topics = [...topics, value];
      void (async () => {
        await saveTopicsToLocalStorage(storageBridge, topics);
        renderTopicsList();
        appendEventLog(`Topic added: ${value}`);
      })();
    }
    if (newTopicInput) {
      newTopicInput.value = '';
    }
  });

  topicsDeleteBtn?.addEventListener('click', () => {
    if (!topicsListEl) return;
    const selected = topicsListEl.querySelector('li.selected') as HTMLLIElement | null;
    if (!selected) {
      setStatus('No topic selected to delete.');
      return;
    }
    const index = Number(selected.dataset.index ?? '-1');
    if (index >= 0 && index < topics.length) {
      const removed = topics[index];
      topics = topics.filter((_, i) => i !== index);
      void (async () => {
        await saveTopicsToLocalStorage(storageBridge, topics);
        renderTopicsList();
        appendEventLog(`Topic deleted: ${removed}`);
        setStatus(`Deleted topic: ${removed}`);
      })();
    }
  });

  topicsSaveBtn?.addEventListener('click', () => {
    void (async () => {
      await saveTopicsToLocalStorage(storageBridge, topics);
      appendEventLog('Topics list saved.');
      setStatus('Topics saved. They will be used when starting new research.');
    })();
  });

  useTranscriptBtn?.addEventListener('click', () => {
    if (!promptTextarea) return;
    void (async () => {
      const last = await getStorageValue('article-publisher:last-transcript');
      promptTextarea.value = last;
      if (!last) {
        appendEventLog('No last transcript found in storage.');
      } else {
        appendEventLog('Loaded last transcript into prompt box.');
      }
    })();
  });

  /** `undefined` = never synced yet (skip first clear so we do not wipe the box on cold start). */
  let prevResearchIdForPromptClear: string | null | undefined;

  // Expose a small helper so we can update this from main()
  (window as any).__evenPublisherUpdateResearchStatus = (c: EvenPublisherClient | null) => {
    if (!researchStatus) return;

    const nextResearchId = !c ? null : (c.getCurrentResearch()?.id ?? null);
    if (prevResearchIdForPromptClear !== nextResearchId) {
      if (prevResearchIdForPromptClear !== undefined && promptTextarea) {
        promptTextarea.value = '';
      }
      prevResearchIdForPromptClear = nextResearchId;
    }

    const noResearch = nextResearchId == null;
    if (promptSubmitBtn) promptSubmitBtn.disabled = noResearch;
    if (useTranscriptBtn) useTranscriptBtn.disabled = noResearch;
    if (promptTextarea) promptTextarea.disabled = noResearch;

    if (!c) {
      researchStatus.textContent = NO_RESEARCH_ON_GLASSES;
      return;
    }
    const current = c.getCurrentResearch();
    if (!current) {
      researchStatus.textContent = NO_RESEARCH_ON_GLASSES;
    } else {
      researchStatus.textContent = `Current research: ${current.title}`;
    }
  };

  await reloadFromStorage();
}

async function main() {
  installGlobalErrorLogging();
  setStatus('Waiting for Even bridge…');
  const loadingOverlay = document.getElementById('phone-loading-overlay');
  const loadingText = document.getElementById('phone-loading-overlay-text');
  const setLoading = (isVisible: boolean, message?: string): void => {
    if (message && loadingText) loadingText.textContent = message;
    if (!loadingOverlay) return;
    if (isVisible) loadingOverlay.removeAttribute('hidden');
    else loadingOverlay.setAttribute('hidden', '');
  };

  setLoading(true, 'Loading configuration…');
  await bootSettingsUi();
  bootReadAloudStartBanner();
  bootPhoneAudioUi();
  bootResearchPhoneLists();
  //appendEventLog('[main] bootSettingsUi ok');

  const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement | null;

  const connect = async () => {
    if (client) {
      setStatus('Already connected.');
      return;
    }
    try {
      appendEventLog('Connecting to Even bridge…');
      const bridge = await waitForEvenAppBridge();
      storageBridge = bridge;
      setPhoneAudioStorageBridge(bridge);
      setLoading(true, 'Loading bridge storage…');
      await refreshSettingsUiFromStorage?.();

      client = new EvenPublisherClient(bridge);
      await client.init();
      setStatus('Connected. Use glasses main menu to start.');
      appendEventLog('Bridge connected and Article Publisher client initialised.');
      document.getElementById('g2-connection-body')?.setAttribute('hidden', '');
      document.getElementById('g2-connection-connected')?.removeAttribute('hidden');

      const updateStatusFn = (window as any).__evenPublisherUpdateResearchStatus as
        | ((client: EvenPublisherClient | null) => void)
        | undefined;
      if (updateStatusFn) {
        updateStatusFn(client);
        if (statusTimer !== null) {
          window.clearInterval(statusTimer);
        }
        statusTimer = window.setInterval(() => {
          updateStatusFn(client);
        }, 3000);
      }
      window.__evenPublisherRefreshResearchLists?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Bridge not available: ${message}\n\nRunning in browser-only mode.`);
      appendEventLog(`Bridge connection failed: ${message}`);
    } finally {
      setLoading(false);
    }
  };

  // Auto-connect on load (after bootSettingsUi registers __evenPublisherUpdateResearchStatus)
  await connect();

  // Keep button as manual retry
  connectBtn?.addEventListener('click', () => {
    void connect();
  });

  const promptSubmitBtn = document.getElementById('prompt-submit') as HTMLButtonElement | null;
  const promptTextarea = document.getElementById('prompt-text') as HTMLTextAreaElement | null;

  promptSubmitBtn?.addEventListener('click', async () => {
    const prompt = promptTextarea?.value ?? '';
    if (!client) {
      setStatus('Not connected to glasses. Connect first, then open a research on the glasses.');
      return;
    }
    try {
      await client.applyPromptToCurrentResearch(prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Failed to apply prompt: ${message}`);
      appendEventLog(`Prompt submit error: ${message}`);
    }
  });
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[article-publisher] boot failed', error);
  setStatus('App boot failed');
});

