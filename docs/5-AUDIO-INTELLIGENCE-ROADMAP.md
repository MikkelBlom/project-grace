# 5 — Audio Intelligence Roadmap

Status: **design / backlog** (not yet implemented). Captured 2026-06-10 during the
Whisper→Arc-iGPU migration. Prereq context: see [grace-vram-performance] memory and
`grace_whisper_server.py` (the `openvino` backend + `config/stt-bias.json`).

This doc has two halves:
1. **Dynamic contextual STT biasing** — make Whisper's hotword list live and context-aware.
2. **NPU audio roster** — small always-on models for the idle Intel AI Boost NPU.

---

## Part 1 — Dynamic contextual STT biasing

### The idea
Whisper biasing (`initial_prompt` + `hotwords`) is *soft attraction*: words in the prompt
get a higher prior. Today the list is **static** (`config/stt-bias.json`). The upgrade:
rebuild the hotword set **per utterance from what's live on Mikkel's machine**, so the STT
is primed for exactly what he's likely to say right now.

The OpenVINO `WhisperPipeline` rebuilds its generation config per call cheaply, so swapping
the hotword set every utterance is practically free.

### Sources of live hotwords (Grace already has most of this plumbing)
- **Filesystem** — when the active context is file work, inject nearby **file and folder
  names / paths** (from `data/spatial-map.json`, recent dirs, the active explorer/editor
  path). Goal: *"find X in folder Y"* stops mishearing the folder name. High value.
- **Active application vocabulary** — a per-app hotword pack, swapped on focus change
  (contextDetector already reports the active window):
  - **VS Code / Rider** → open symbols, filenames, language keywords
  - **Claude / ChatGPT (browser)** → Anthropic/OpenAI/model vocabulary
  - **Overleaf (Chrome)** → LaTeX commands, the doc's section titles, citation keys
  - **Terminal** → recent commands, tool names, branch names
  - **Antigravity** → its surface vocabulary
- **Clipboard** — recent clipboard tokens (Grace already reads clipboard).
- **Conversation** — proper nouns / unusual terms from the last few turns.

### The bigger idea Mikkel raised: Grace *builds and links* her own hotword lists
Not just hardcoded per-app packs. Grace should **learn and persist** bias lists and bind
them to contexts — and contexts need not be only "which app":
- A context could be an **app**, a **project/folder**, a **document**, a **website**, a
  **task/mission**, or a **time/activity** ("evening coding", "writing thesis").
- Grace **observes** which words she mis-hears (low-confidence tokens, or words Mikkel
  corrects) and **promotes** them into the relevant context's list automatically.
- Lists are **composable**: a session merges the global list + active-app list +
  active-project list + recent-conversation list, deduped, trimmed to Whisper's ~224-token
  prompt budget (priority = recency × mishear-frequency).
- Persisted as data (e.g. `data/bias/<context-key>.json`) so they survive restarts and grow
  over time. This is a self-improving vocabulary, in the spirit of Grace's self-evolution.

### Guardrails (learned the hard way)
- Biasing is **soft attraction** → it pulls near-homophones. Adding "Node" pulled
  "Notes"→"Node". Rule: list both members of a near-homophone pair when both occur, and
  keep lists focused on words actually said *and* mis-heard.
- Respect the **~224-token prompt budget**; over-stuffing degrades general accuracy.
- Pair soft biasing with a **deterministic post-correction dictionary** for known recurring
  mishears (e.g. "jemini→Gemini", "klod→Claude", "gris→Grace"). Post-correction can't cause
  false pulls, so it's the safe complement to the soft list.

### Rough build order
1. Static per-app packs keyed off contextDetector focus (quick win).
2. Filesystem path injection for file-work contexts.
3. Per-utterance merge + trim pipeline feeding the OV generation config.
4. Mishear-observation → auto-promotion into persisted per-context lists.
5. Post-correction dictionary (parallel track, independent of the above).

---

## Part 2 — NPU audio roster (Intel AI Boost)

The NPU (Arrow Lake, ~13 TOPS INT8) choked on Whisper's autoregressive *decoder*, but it is
ideal for **small, static-shape, always-on** models. Crucially, NPU models do **not** occupy
fixed memory like GPU models — they compile and **time-share** the engine, streaming weights
from system RAM (of which there's plenty). So "how many fit" is about **throughput + per-model
op-compatibility**, not a VRAM-style cap. All candidates below are tiny; capacity is not the
worry — per-model NPU compilation is (test each individually, like we did for Whisper).

### Decisions from Mikkel (2026-06-10)
- **Wake-word — REJECTED.** Grace is always-active by core design; she has no wake word and
  must not get one. Do not implement.
- **Speaker identity — TOP PRIORITY.** Know when audio is *Mikkel* vs *music* vs *Grace's
  own TTS* vs *other people*. Unlocks two big wins (see below).
- **Speech denoise — wanted.** Clean the far-field Realtek mic before Whisper.
- **nomic-on-NPU — deferred.** ("good idea, but…" — reservation TBD; not needed now since the
  iGPU move already freed GPU headroom. Revisit only to reclaim the GPU slot or stack more.)

### Candidate models (all small, all encoder-style → NPU-friendly)
| Model | Job | Duty cycle | ~Size | NPU fit |
|---|---|---|---|---|
| **AEC (echo cancel)** | subtract Grace's known TTS from mic input | continuous | tiny DSP+NN | strong |
| **Speaker verification** (ECAPA/x-vector) | is this Mikkel? music? Grace herself? other? | per-utterance | ~6–20M | strong |
| **Speech denoise** (DeepFilterNet-style) | clean far-field mic pre-Whisper | continuous | ~2M | strong |
| **VAD** (silero) | speech/silence gate (already runs, on CPU) | continuous | ~1.8M | easy move |
| **Language ID** (da/en) | per-utterance, to switch Whisper lang + bias | per-utterance | small | likely |
| **Prosody/emotion** | tone of voice → modulate Grace's manner | per-utterance | small | likely |
| nomic embedder | semantic memory embeddings | occasional | 137M | deferred |

### The standout win: kill the mic-mute echo hack
Today Grace **mutes the mic while TTS speaks** (echo workaround) → she's deaf during her own
replies, so barge-in is clumsy. Two NPU paths fix this properly and let her **listen while
speaking**:
- **AEC** — subtract the known TTS audio from the mic signal (textbook, direct echo fix), **or**
- **Speaker-self-ID** — recognize her *own* voice and ignore it.
AEC is the more direct fix; speaker-ID is a clever bonus that *also* gives "only answer Mikkel,
ignore music/TV, and respond to other people only if they say 'Grace'." Best combo: **AEC +
speaker verification** together — they share the always-on audio path and complement each other.

### How many reasonably fit?
Throughput-wise, the continuous pair (**denoise + VAD**) plus **AEC** plus per-utterance bursts
(**speaker-ID**, optionally **language-ID / prosody**) all coexist on ~13 TOPS — they're tiny
and time-share. Realistic target: **3 always-on small models + 1–2 bursty ones**, with nomic as
a deferred heavyweight. The true gate is **per-model NPU op support** (some will need static-shape
massaging or fall back to the iGPU), measured one at a time. Plan to validate in this order:
1. **Speaker verification** (Mikkel's favourite; unlocks self-ID + only-answer-me)
2. **AEC** (or fold into #1) → remove the mic-mute, enable listen-while-speaking
3. **Speech denoise** (accuracy at the mic source)
4. **VAD** move (trivial offload)
5. *(later)* language-ID, prosody, nomic

### New ideas worth weighing
- **Acoustic echo cancellation** (above) may *trump* plain speaker-self-ID for the echo goal.
- **Language-ID** ties directly into Part 1 — detect a switch to English and flip Whisper's
  language + bias pack mid-conversation (helps the English-tech-word problem).
- **Prosody/emotion** — let Grace read tone (tired, stressed, excited) and adapt. Fits a
  *personal* assistant; small classifier, NPU-friendly.

---

## Part 3 — Grace's emotional layer (detect AND simulate)

Mikkel wants Grace to not just *detect* emotion but *have* (simulate) it — to be more relatable
to talk to — without it obscuring her purpose or making her unreliable. Two directions:

- **Detect (input):** prosody/emotion classifier on the NPU (Part 2) → Grace knows Mikkel's mood
  and can adapt (gentler when he's stressed, brief when he's busy).
- **Simulate (output) — in words:** a lightweight internal **mood state** that drifts with
  context (his tone, time of day, how the work is going, recent wins/frustrations) and colours her
  word choice and warmth. NOT a mask over facts — she stays honest; mood only flavours *delivery*.
  Implementation: a small persisted mood vector + a few lines in the system prompt describing the
  current mood, updated each turn. Cheap (prompt-level), no extra model.
- **Simulate (output) — in voice:** Kokoro is fixed-affect. Two routes: (a) swap to / add an
  **expressive TTS** that supports emotion/style conditioning, or (b) **prosody post-processing**
  on Kokoro output (modulate pitch / rate / energy to match mood) — cheaper, CPU/GPU light.
  Start with (b) as a quick win; evaluate (a) if it's not enough.

Guardrail: emotion is *flavour*, never *fact distortion*. She can sound warm, tired, or amused,
but must not let mood change what's true or skip doing the work.

---

## Part 4 — Broader idea backlog (by compute tier)

Raw ideas to triage into the Jira roadmap. Not commitments — a menu. Grouped by where the cost lands.

### Pipeline / UX (highest perceived-latency wins — do these early)
- **Streaming TTS** — start speaking sentence 1 while the LLM is still generating the rest, instead
  of waiting for the whole reply. Likely the single biggest *felt* speedup. (GPU/pipeline.)
- **Draft-model acknowledgements** — a tiny fast model (or canned set) emits an instant "mhm",
  "lige et øjeblik", "godt spørgsmål" the moment Mikkel stops talking, so she never feels frozen
  while the 26b thinks. (Small GPU/CPU model.)
- **Rule-based fast-path** — skip the LLM entirely for trivial commands ("stop", "louder", "what
  time is it", "pause") → instant response. (CPU.)
- **Better turn-taking / endpointing** — distinguish "done talking" from "mid-pause" so she doesn't
  cut in or wait awkwardly. Pairs with VAD work. (CPU/NPU.)
- **Barge-in while speaking** — enabled by AEC + speaker-ID (Part 2); interrupt without the mic-mute.

### LLM / GPU
- **Streaming + speculative decoding** to speed the 26b generation.
- **Prompt prefix caching** kept healthy (already fixed once) — guard it doesn't regress.
- **Local RAG / web search** so she can answer current-info questions, cited.
- **Proactive context** — gemma vision periodically reads the screen and offers help unprompted
  (carefully gated, opt-in, not naggy).
- **Local image generation** (SDXL/Flux) if she ever needs to *make* visuals, not just see them.

### CPU
- **STT post-correction dictionary** — deterministic fixes for recurring mishears (Part 1).
- **Faster / parallel tool execution.**
- **Interruption memory** — if barged-in mid-task, remember exactly where to resume.

### RAM
- **Longer LLM context** now that VRAM is freed (more history / bigger live-context window).
- **Caches** — embedding cache, tool-result cache, so repeated work is instant.
- **Keep more models warm** simultaneously (the whole point of the iGPU/NPU offload).

### Cross-cutting / future
- **Whole-house presence** (cameras + mics around the house) — multi-room, multi-speaker, with
  speaker-ID deciding who Grace listens to. (Mikkel's long-term vision.)
- **Persisted personality/mood** across sessions (Part 3).
- **Connector tools** — calendar, email, Notion, etc. (MCP connectors already available).
- **Self-evolution guardrails** — as Grace builds her own tools/bias lists, keep an audit + rollback.

---

## Research decisions (2026-07-20) — the local audio stack to adopt

Decision-ready picks from a live-web research spike (cited fully in the session notes). All chosen to
stay OFF the RTX (LLM) and OFF the Arc iGPU (Whisper), leaning on CPU / small ONNX.

- **Speaker verification / diarization / streaming STT → one dependency: `sherpa-onnx`** (Apache-2.0,
  pip, offline, Windows-native, CPU). WeSpeaker-ResNet34 (~27 MB, sub-1% EER) for the voice gate — it
  only responds to Mikkel; its ONNX diarization for meetings (no HF-gated-model token dance); streaming
  Zipformer-EN for instant partials (Danish partials stay on a whisper_streaming wrapper of the existing
  OpenVINO Whisper, since streaming Zipformer is English-centric). Speaker-ID is language-independent.
  **Built:** `grace_speaker_server.py` (enroll/verify/reset/health; cosine gate, threshold 0.5).
- **Denoise → DeepFilterNet3** (~2M params, real-time on CPU; Intel ships an OpenVINO IR for Arc/NPU).
  **AEC** (cancel Grace's own TTS from the mic) → Windows Communications-mode AEC or half-duplex /
  push-to-talk while she speaks, rather than a hand-rolled AEC.
- **Emotion/prosody (optional) → SenseVoice-Small ONNX** (ASR + emotion + language-ID + events in one
  ~70ms pass on CPU); emotion2vec ONNX export is not production-ready yet.
- **NPU caveat:** AI Boost only runs static-shape graphs — usable for fixed-window denoise/speaker-embed
  offload, NOT variable-length ASR. Keep variable-length ASR on Arc (Whisper) + CPU (Zipformer).

### Expressive TTS (beyond flat Kokoro)
- **Pick: Chatterbox** (MIT) — the only open model with a real emotion-intensity knob (`exaggeration`)
  AND Danish (Multilingual variant) AND a streaming path (<500ms first chunk). **Run it on CPU** (Turbo
  350M makes that realistic) so a per-turn TTS load never evicts the 26B and wipes its prefix cache.
  Keep **Piper `da_DK`** (MIT, CPU, instant) as the low-latency Danish fallback for short confirmations.
  Two-tier: Piper for snappy/short, Chatterbox for expressive/longer.
