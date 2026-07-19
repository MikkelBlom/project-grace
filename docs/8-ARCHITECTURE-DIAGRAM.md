# Grace — Architecture Diagram

The runtime data flow. Everything talks over the typed `bus` (`@grace/core`). See
`2-ARCHITECTURE-AND-SYSTEM.md` for the prose version.

```mermaid
flowchart TD
  Mic["🎤 Mic"] --> STT["WhisperSTT<br/>OpenVINO on Arc iGPU<br/>Røst Danish fine-tune"]
  Text["⌨ Text input<br/>(GRACE_TEXT_INPUT)"] -->|stt:heard| Core
  STT -->|"stt:heard {text, confidence}"| Core["GraceCore<br/>orchestrator"]

  Core -->|"post-ASR corrections<br/>Ja/Nej safety gate<br/>language mode<br/>token-budgeted history"| LLM["OllamaLLM<br/>gemma4:26b · tool loop<br/>router + verify-before-done"]

  LLM <-->|call / result| Tools["~85 tools<br/>files · search · web · memory<br/>vision · focus · modes · system"]
  LLM <-->|RAG per turn| Mem["graceMemory<br/>Chroma (vectors) + sqlite (turns)<br/>embed: nomic → e5 (off-GPU, opt-in)"]
  Tools --> Research["research / fact_check<br/>SearXNG→fetch→source-verify"]
  Tools --> FsIndex["fsIndex<br/>whole-disk file index + watcher"]

  LLM -->|"tts:speaking"| TTS["KokoroTTS<br/>EN: Kokoro af_heart<br/>DA: Piper (GRACE_TTS_DA_URL)"]
  TTS -->|audio| Speaker["🔊"]

  Core -->|overlay:*| Overlay["Electron HUD<br/>vignette + focus_box<br/>modes: focus / eye-pause / field-notes"]
  Core -->|"tts:done → isProcessing (watchdog)"| Core
```

**Side processes (HTTP, launched by `start-grace.ps1`):** `grace_whisper_server.py` (STT),
`grace_kokoro_server.py` (EN TTS), `grace_da_tts_server.py` (DA TTS), optional
`grace_embed_server.py` (e5 embedder), Ollama, and Docker: SearXNG (search) + ChromaDB (memory).
