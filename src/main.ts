import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';

import { EvenPublisherClient } from './even-client';
import {
  appendEventLog,
  installGlobalErrorLogging,
  loadConfigFromLocalStorage,
  saveConfigToLocalStorage,
  setStatus,
  loadTopicsFromLocalStorage,
  saveTopicsToLocalStorage,
  withTimeout,
} from './utils';

let client: EvenPublisherClient | null = null;
let statusTimer: number | null = null;

const NO_RESEARCH_ON_GLASSES = 'No research selected on glasses.';

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

function bootSettingsUi(): void {
  const config = loadConfigFromLocalStorage();

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

  if (googleGenerativeKeyInput) googleGenerativeKeyInput.value = config.googleGenerativeApiKey;
  if (openAiKeyInput) openAiKeyInput.value = config.openAiApiKey;
  if (openAiModelInput) openAiModelInput.value = config.openAiModel;
  if (elevenLabsKeyInput) elevenLabsKeyInput.value = config.elevenLabsApiKey;
  if (wpUrlInput) wpUrlInput.value = config.wordpressBaseUrl;
  if (wpUserInput) wpUserInput.value = config.wordpressUsername;
  if (wpPassInput) wpPassInput.value = config.wordpressPassword;

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

  let topics = loadTopicsFromLocalStorage();

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

  renderTopicsList();

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
    saveConfigToLocalStorage(next);
    appendEventLog('Settings saved.');
    setStatus('Settings saved. You can now start a new research from glasses.');
    if (allAiSettingsFieldsFilled()) {
      aiSettingsExpanded = false;
      syncAiSettingsPanel();
    }
  });

  topicsAddBtn?.addEventListener('click', () => {
    const value = newTopicInput?.value.trim() ?? '';
    if (!value) {
      setStatus('Topic is empty. Type a name first.');
      return;
    }
    if (!topics.includes(value)) {
      topics = [...topics, value];
      saveTopicsToLocalStorage(topics);
      renderTopicsList();
      appendEventLog(`Topic added: ${value}`);
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
      saveTopicsToLocalStorage(topics);
      renderTopicsList();
      appendEventLog(`Topic deleted: ${removed}`);
      setStatus(`Deleted topic: ${removed}`);
    }
  });

  topicsSaveBtn?.addEventListener('click', () => {
    saveTopicsToLocalStorage(topics);
    appendEventLog('Topics list saved.');
    setStatus('Topics saved. They will be used when starting new research.');
  });

  useTranscriptBtn?.addEventListener('click', () => {
    if (!promptTextarea) return;
    const last = localStorage.getItem('even-publisher:last-transcript') ?? '';
    promptTextarea.value = last;
    if (!last) {
      appendEventLog('No last transcript found in storage.');
    } else {
      appendEventLog('Loaded last transcript into prompt box.');
    }
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
}

async function main() {
  installGlobalErrorLogging();
  setStatus('Waiting for Even bridge…');

  bootSettingsUi();
  appendEventLog('[main] bootSettingsUi ok');

  const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement | null;

  const connect = async () => {
    if (client) {
      setStatus('Already connected.');
      return;
    }
    try {
      appendEventLog('Connecting to Even bridge…');
      const bridge = await waitForEvenAppBridge();
      client = new EvenPublisherClient(bridge);
      await client.init();
      setStatus('Connected. Use glasses main menu to start.');
      appendEventLog('Bridge connected and EvenPublisherClient initialised.');
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Bridge not available: ${message}\n\nRunning in browser-only mode.`);
      appendEventLog(`Bridge connection failed: ${message}`);
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
  console.error('[even-publisher] boot failed', error);
  setStatus('App boot failed');
});

