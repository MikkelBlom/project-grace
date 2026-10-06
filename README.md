# Grace

A voice assistant that runs 100% locally on my own PC. You talk to her, she answers out loud, and she can use tools on the computer - search files, read the screen, do research on the web, take notes, etc. Speech recognition, the language model and the voice all run on the machine, with no cloud AI involved.

**Status:** work in progress, and far from done. The individual parts work and have been tested on their own, and the full voice loop has worked in live tests. But the whole idea (an assistant that is always listening and actually useful day to day) does not work yet. It is something I plan to keep working on.

## The idea

Most voice assistants are a cloud service with a wake word. I wanted to see how far you can get with everything running locally on a gaming laptop (RTX 5090 with 24 GB VRAM, plus the Intel Arc iGPU):

- **No wake word.** Grace uses voice activity detection, so you just talk. You can also interrupt her mid-sentence.
- **Local and private.** Memory, models and everything she does stay on the machine. The internet is only used for things like web search and weather.
- **Context over answers.** She keeps a long-term memory (a vector database), so she can remember what was said yesterday or what I was working on.
- **She can act, not just answer.** She has about 100 tools, and she can start a "mission" in the background, plan it as a list of steps and report back when she is done. She can even write new tools for herself in a Docker sandbox, and they go live without a restart.
- **Danish and English.** You can switch language by voice.

## How it works

```
microphone → Whisper (speech to text, on the Intel Arc iGPU)
           → gemma4 via Ollama (the "brain", with a multi-step tool loop)
           → Kokoro (text to speech)
           → speaker + an Electron overlay (HUD) for anything too long to read out loud
```

- **TypeScript monorepo** (npm workspaces): `core` (event bus and orchestration), `llm`, `stt`, `tts`, `tools` and `overlay` (Electron).
- Everything talks through one typed event bus, so the parts don't know about each other directly.
- **Speech to text** is OpenVINO Whisper large-v3 on the Arc iGPU, which leaves the NVIDIA GPU free for the language model. A small correction dictionary fixes names that Whisper reliably mishears, and Grace can be taught new corrections by voice.
- **The language model** is gemma4 through Ollama. It is multimodal, so the same model also handles screenshots.
- **Speech** is Kokoro-82M in a small Python server. Danish voices are wired up but not tested live yet.
- **Search** goes through a local SearXNG instance first, with fallbacks. The `research` tool reads the sources and checks them before answering.
- **Safety:** commands that could do damage are hard-blocked, a "yes/no" from the voice has to pass a confidence check and defaults to "no", and drafting an email never sends it.

The design documents in [`docs/`](docs/) go through the vision, the architecture, the tools and the known issues in detail. Some of them are in Danish.

## Running it

It is built for my own machine (Windows 11, NVIDIA GPU, Intel Arc iGPU, Node 24 and Python 3.12), so it will probably need some changes to run elsewhere. [`SETUP.md`](SETUP.md) has the full setup (in Danish).

```bash
npm install
npm run build
npm run dev        # overlay + mock pipeline, no models needed
```
