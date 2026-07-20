# Grace — Remaining items: design + status

From the big idea list, these items are **built to the point autonomous work can reach**, but their
completion needs one of: model downloads (blocked — you're on mobile data), live audio + voice
enrollment, or live visual validation of the HUD. Design + what's done below, so a later live session
finishes them cleanly.

## Deep audio / NPU (needs models + live audio)
- **1 Speaker verification** — plan: a `grace_speaker_server.py` computing a speaker embedding
  (e.g. SpeechBrain ECAPA or Resemblyzer) at enrollment, then cosine-comparing each utterance; gate
  responses to Mikkel's voice. NEEDS: model download + a one-time enrollment recording. Not built
  (can't download now).
- **2 Denoise / AEC** — plan: an RNNoise/DeepFilterNet pass before Whisper, or the NPU denoise
  roster. NEEDS: model + live audio. Not built.
- **6 Streaming STT** — plan: partial transcripts from the OpenVINO Whisper pipeline (chunked
  decode) for lower latency. NEEDS: live audio to tune endpointing. Not built (would modify the
  working STT server; deferred to avoid breaking it without a live test).
- **60 Whisper/embed on NPU** — plan: OpenVINO NPU device target (per the earlier NPU spike, the
  decoder was incompatible; wav2vec2/embeddings are more promising). NEEDS: model conversion +
  on-device benchmark.
- **3 Emotion/prosody detect, 4 expressive TTS, 7 diarization, 9 ambient sound** — each needs a
  dedicated model (SER, prosody-control TTS, pyannote diarization, YAMNet classifier) + live audio.
  Designs noted; not built (downloads blocked).

Done autonomously in this area: **8 language auto-switch** (text-based, `GRACE_AUTO_LANG`),
**post-ASR correction**, **Ja/Nej confidence gate**, **dynamic hotword bias** — all shipped earlier.

## UI / HUD (needs live visual validation)
The HUD renderer is generated in TypeScript (`packages/overlay/src/vignetteWindow.ts`), with no
static HTML — changing it safely needs to be *seen*. Rewriting it blind (while you're driving) risks
the working overlay, so:
- **70 Notification center** — DATA LAYER BUILT: `notificationCenter` (core) logs every alert to a
  rolling store; `list_notifications` tool reads it. The visual panel is a later renderer add.
- **65 Focus-timer countdown** — state is available (`focus_status`); needs a small renderer widget.
- **64 HUD chat transcript** — needs a renderer scrollback fed by the `overlay:show`/speaking events.
- **69 Theme support, 68 smarter multi-monitor, 21 confidence badges** — renderer/CSS work; live pass.

## Adaptive / signals (needs input hooks)
- **51 Adaptive Deep Work, 52 energy/mood auto-inference** — need typing-speed / app-switch signals.
  App-switch is available via `contextDetector`; keystroke timing needs an input hook (AMSI-sensitive,
  wants a live test). The manual `focus_timer` + `log_mood` cover the user-facing parts today.

## Already effectively covered
- **59 Draft/instant acks** — Grace can already set `speak` AND a tool in the same reply, so she can
  say "let me check…" while the tool runs. Guidance supports it.
- **48 Memory decay** — semantic search is recency-weighted and the journal is capped;
  `consolidate_memory` dedups. Importance-weighted decay can layer on later.
- **61 KV-cache warm** — `keep_alive:-1` pins the model between turns (done).
