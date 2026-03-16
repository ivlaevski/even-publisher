Even Publisher – G2
====================

Even Publisher is a companion app for the Even Realities G2 glasses that helps you discover current news on selected topics, generate reflective LinkedIn‑style posts with AI, refine them by voice or text, and schedule or publish them via WordPress – all driven primarily from the glasses, with configuration and topic management handled on the phone.

## Features

- **Main menu on glasses**
  - Centered title `EvenPublisher` and subtitle `by Ivan Vlaevski v.1.0`.
  - Footer message: `Revolute to @ivanvlaevski`.
  - Menu options:
    - **Start new research** – discover fresh news and generate a new research draft.
    - **Continue old research** – open and refine previously created drafts.
    - **Review Ready for Publishing** – inspect, tweak and publish finalized researches.

- **Topic management on phone**
  - In `index.html`, the “Prompt Topics” card lets you:
    - View the current list of topics.
    - Add a new topic via an input field and “Add topic” button.
    - Select a topic from the list and remove it via “Delete selected”.
    - Persist the list using the “Save list” button.
  - Topics are stored in `localStorage` (`even-publisher:topics`) and are used when starting new research on the glasses.

- **Start new research flow**
  - When you choose **Start new research** on the glasses:
    1. The client loads topics from the phone and, if any exist, shows a **topic selection** list.
    2. After selecting a topic, the app calls OpenAI with a prompt like  
       “Provide the 5 most recent news events related to \<selected topic\>”.
    3. A scrollable list of news items is shown; tapping opens details, and tapping again creates a **research draft**.
  - If no topics are configured on the phone, the flow falls back to the default topic “Artificial Intelligence”.

- **AI integration**
  - Uses OpenAI Chat Completions to:
    - Fetch the 5 most recent news items for the selected topic (JSON‑only response).
    - Elaborate a selected news item into a LinkedIn post draft in the voice of a seasoned technology leader.
    - Apply refinement prompts to an existing draft while preserving tone and structure.

- **Research lifecycle**
  - Draft researches are stored locally on the device (via Even Hub storage).
  - Views on the glasses:
    - **Draft list** – choose which draft to open.
    - **Research detail** – paginated view with scroll and a double‑tap menu.
    - **Research menu** for the current draft:
      - **Read aloud** – line‑by‑line TTS playback.
      - **Start / stop voice prompt (record)** – capture a spoken refinement request via ElevenLabs STT.
      - **Mark as Ready for Publish** – move draft into the “ready” list.
      - **Cancel research** – delete the draft after a confirmation (Yes / No) dialog and return to the main menu.

- **Read‑aloud mode**
  - Converts the current research into lines and:
    - Shows one line at a time on the glasses.
    - Reads each line aloud via ElevenLabs TTS.
  - Gesture controls while in `research-read-aloud`:
    - **Tap** – pause / resume the current line.
    - **Scroll down** – stop audio and move to the next line.
    - **Scroll up** – re‑play the previous line.
    - **Double‑tap** – exit read‑aloud and return to `research-detail`.
  - When the last line finishes, the app automatically returns to the research detail view.

- **Voice prompts (STT)**
  - Uses ElevenLabs speech‑to‑text:
    - Opens the G2 microphone and streams PCM audio from Even Hub.
    - Sends audio as WAV to ElevenLabs STT.
    - Stores the transcription in local storage (`even-publisher:last-transcript`) for reuse on the phone.
  - On the phone, a “Use last voice transcript” button fills the refinement prompt textbox with the last transcription.

- **Ready for publishing & WordPress**
  - Researches marked as **ready** appear in the “Ready for publishing” list.
  - The **ready detail** view:
    - Shows the content with a configurable delay (0–10 days).
    - Supports scrolling and adjusting delay with gestures.
  - **Ready menu** options:
    - **Publish now** – sends the content to a configured WordPress site using the REST API.
    - **Cancel publishing** – after a Yes / No confirmation, removes the research and goes back to main menu.
    - Navigation options back to the ready list or main menu.

- **Settings on phone**
  - “AI & Publishing Settings” card provides inputs for:
    - OpenAI API key and model.
    - ElevenLabs API key.
    - WordPress base URL, username and application password/token.
  - Settings are stored only on the phone in `localStorage` and are read by the client before making any external API calls.

## Installation and preparation

To use Even Publisher end‑to‑end you will need:

- An **OpenAI account** and an API key with access to the selected chat model (e.g. `gpt-4.1-mini`).
- An **ElevenLabs account** and an API key with access to:
  - Text‑to‑Speech (for read‑aloud).
  - Speech‑to‑Text (for voice prompts).
- A **WordPress site** configured to accept remote posting via the REST API:
  - Enable application passwords or token‑based authentication for the user that will create posts.
  - Ensure the base URL is reachable from the device running the Even Publisher WebView.

Basic setup steps:

1. **Clone and install**
   - Clone this repository.
   - Install dependencies (for example):
     - `npm install`
     - `npm run dev` (or the dev script defined in `package.json`).

2. **Open the phone (Web) UI**
   - Launch the dev server in a browser on your phone (or the device hosting the Even Hub WebView).
   - You should see the Even Publisher UI with:
     - G2 Connection card.
     - Prompt Topics card.
     - Prompt Research refinement card.
     - AI & Publishing Settings card.

3. **Configure external services**
   - In **AI & Publishing Settings**:
     - Paste your **OpenAI API key** and desired model name.
     - Paste your **ElevenLabs API key**.
     - Set your **WordPress base URL**, username and application password/token.
   - In **Prompt Topics**:
     - Add at least one topic (e.g. “Artificial Intelligence”) and save the list.

4. **Connect the G2 glasses**
   - On the phone UI, click **Connect glasses** and wait for the status to show that the Even bridge is connected.
   - On the G2, use tap, double‑tap and swipe gestures to navigate the startup page and open the main menu.

## Architecture overview

- **`src/even-client.ts`**
  - Core Even Publisher client running inside the Even Hub WebView.
  - Manages UI state, view rendering on glasses, and all gesture handling.
  - Orchestrates calls to OpenAI, ElevenLabs, and WordPress via helper modules.

- **`src/api.ts`**
  - Wraps OpenAI and WordPress calls:
    - `fetchLatestAiNews(config, topic)` – topic‑driven news retrieval.
    - `elaborateResearch` – generate long‑form LinkedIn‑style content from a selected news item.
    - `refineResearch` – apply user prompts to existing research content.
    - `publishToWordPress` – create draft posts on a target WordPress site.

- **`src/main.ts`**
  - Boots the phone (Web) UI:
    - Manages configuration fields and topics UI in `index.html`.
    - Connects to the Even App bridge and instantiates `EvenPublisherClient`.
    - Provides a simple status indicator for the currently selected research.

- **`src/utils.ts`**
  - Helper functions:
    - Status and log handling for the phone UI.
    - Config and topic persistence in `localStorage`.
    - Small helpers like `clamp` and `generateId`.

- **`src/stt-elevenlabs.ts`**
  - Handles raw audio streaming from G2 and calls ElevenLabs STT.
  - Builds WAV containers from PCM chunks and posts them as multipart form data.

## Getting started (high level)

1. **Install and build**  
   Run the project’s standard install/build commands (e.g. `npm install` / `npm run dev` or the commands defined in this repo).

2. **Configure on phone (WebView)**  
   - Open the Even Publisher WebView on your phone.
   - Enter your OpenAI and ElevenLabs keys, and WordPress credentials.
   - Define one or more topics in the **Prompt Topics** card and save the list.

3. **Connect G2 glasses**
   - Press **Connect glasses** in the G2 Connection card.
   - Wait for the status “Connected. Use glasses main menu to start.”

4. **Use the glasses**
   - From the main menu select **Start new research**.
   - Choose a topic, pick a news item, and let the app generate a draft.
   - Use the research menu to read aloud, record voice prompts, or mark as ready.
   - From “Ready for publishing”, adjust delay and publish to WordPress or cancel.

This README is a high‑level description of the implemented functionality; see the TypeScript source files under `src/` for the precise behavior and APIs.

## License

This project is licensed under the **MIT License**.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.