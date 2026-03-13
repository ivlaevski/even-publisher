import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';

import { EvenPublisherClient } from './even-client';
import {
  appendEventLog,
  loadConfigFromLocalStorage,
  saveConfigToLocalStorage,
  setStatus,
  withTimeout,
} from './utils';

function bootSettingsUi(): void {
  const config = loadConfigFromLocalStorage();

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

  if (openAiKeyInput) openAiKeyInput.value = config.openAiApiKey;
  if (openAiModelInput) openAiModelInput.value = config.openAiModel;
  if (elevenLabsKeyInput) elevenLabsKeyInput.value = config.elevenLabsApiKey;
  if (wpUrlInput) wpUrlInput.value = config.wordpressBaseUrl;
  if (wpUserInput) wpUserInput.value = config.wordpressUsername;
  if (wpPassInput) wpPassInput.value = config.wordpressPassword;

  saveBtn?.addEventListener('click', () => {
    const next = {
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

  // Expose a small helper so we can update this from main()
  (window as any).__evenPublisherUpdateResearchStatus = (client: EvenPublisherClient | null) => {
    if (!researchStatus) return;
    if (!client) {
      researchStatus.textContent = 'No research selected on glasses.';
      return;
    }
    const current = client.getCurrentResearch();
    if (!current) {
      researchStatus.textContent = 'No research selected on glasses.';
    } else {
      researchStatus.textContent = `Current research: ${current.title}`;
    }
  };
}

async function main() {
  bootSettingsUi();
  setStatus('Waiting for Even bridge…');

  const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement | null;
  const actionBtn = document.getElementById('actionBtn') as HTMLButtonElement | null;

  let client: EvenPublisherClient | null = null;
  let statusTimer: number | null = null;

  connectBtn?.addEventListener('click', async () => {
    if (client) {
      setStatus('Already connected.');
      return;
    }
    try {
      appendEventLog('Connecting to Even bridge…');
      const bridge = await withTimeout(waitForEvenAppBridge(), 4000, 'waitForEvenAppBridge');
      client = new EvenPublisherClient(bridge);
      await client.init();
      setStatus('Connected. Use glasses main menu to start.');
      appendEventLog('Bridge connected and EvenPublisherClient initialised.');

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
  });

  actionBtn?.addEventListener('click', () => {
    appendEventLog('Action button pressed (no-op). Use glasses gestures to drive the flow.');
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

