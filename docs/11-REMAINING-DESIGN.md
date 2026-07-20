# Grace — Remaining items: design + status

From the big idea list, these items are **built to the point autonomous work can reach**, but their
completion needs one of: model downloads (blocked — you're on mobile data), live audio + voice
enrollment, or live visual validation of the HUD. Design + what's done below, so a later live session
finishes them cleanly.

## Deep audio / NPU (needs models + live audio)
- **1 Speaker verification** — **SERVER BUILT: `grace_speaker_server.py`** (sherpa-onnx WeSpeaker on
  CPU; /enroll, /verify, /reset, /health; cosine gate, persisted voiceprint). NEEDS to go live: the
  ~27 MB WeSpeaker ONNX download, a one-time enrollment recording, and wiring the STT path to POST each
  utterance to /verify before dispatch. See docs/5 "Research decisions" and the server docstring.
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

## UI / HUD
Rather than edit the working vignette blind, the passive widgets were built in a SEPARATE opt-in
window (`GRACE_HUD=1`) per the 2026 overlay research — the vignette is byte-for-byte unchanged until
enabled + tested live. Files: `packages/overlay/src/hudWindow.ts`, `hudPreload.cts`,
`renderer/hud.html`. A mock-data preview harness renders it standalone (scratchpad/hud-preview.html).
- **64 HUD chat transcript** — **BUILT** (live transcript panel, fed by stt:heard/tts:speaking).
- **65 Focus-timer countdown** — **BUILT** (SVG ring, driven by the new `overlay:timer` bus event).
- **70 Notification center** — toast layer **BUILT** (fed by overlay:notification); the interactive
  *history panel* is the next step and should be its OWN window (research: interactive → dedicated
  window). Data layer already exists (`notificationCenter` + `list_notifications`).
- **69 Theme support** — **BUILT** (CSS vars + prefers-color-scheme + nativeTheme→hud:theme).
- **68 smarter multi-monitor, 21 confidence badges** — HUD is on the primary display for now; a
  per-display HUD + confidence badges are a live-pass follow-up.
Go-live: set `GRACE_HUD=1`, confirm placement on the actual monitor(s), then (optional) move the
notification history into a dedicated interactive window.

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
