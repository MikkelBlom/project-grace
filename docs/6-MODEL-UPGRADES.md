# Grace — Model Upgrades (research picks + how to install them)

Researched 2026-07-19, accepted by Mikkel. **Theme: the bottleneck was placement, not the brain.**
Keep `gemma4:26b`; move STT + embeddings off the RTX; specialise STT/embeddings for Danish.

The **code hooks are already in place** (env vars below). What remains needs model downloads and,
for the embedder + Danish TTS, two small Python servers (marked ⏳ — to build next).

## 1. Reasoning + Vision brain — KEEP `gemma4:26b` ✅
MoE (~3.8B active) → 4B speed / 25B quality, best open Danish, ~95% tool-call JSON, native box_2d
vision. No change. Lean fallback if PC headroom is tight: `gemma4:12b`.

## 2. STT → CoRal Røst-v3-whisper-1.5b (Danish fine-tune) — turnkey
~2–2.5× better Danish WER than generic large-v3; same OpenVINO/Arc-iGPU path, zero RTX load.
```powershell
py -3.12 -m pip install --upgrade optimum-intel openvino-genai
optimum-cli export openvino --model CoRal-project/roest-v3-whisper-1.5b `
  --task automatic-speech-recognition-with-past --weight-format fp16 `
  models/ov-roest-v3-whisper-1.5b-fp16
```
Then in `start-grace.ps1`: `GRACE_OV_MODEL = "$graceRoot\models\ov-roest-v3-whisper-1.5b-fp16"` (keep `GRACE_WHISPER_LANG=da`).
Code-switching (Grace/Gemma/Claude) is handled separately by `config/stt-corrections.json` + `add_stt_correction`.
Validate on a 20–30 clip Danish set incl. isolated "Ja"/"Nej" before trusting delete confirmations.

## 3. Embeddings → multilingual-e5-base, OFF the RTX ⏳ (needs embed server)
`nomic-embed-text` is **English-only** — a weak retriever for Danish memory. e5-base is strong on
Danish/Scandinavian and runs fast on CPU/ONNX so it stops evicting the LLM.
```powershell
py -3.12 -m pip install fastembed   # downloads the e5 ONNX (~200MB) on first use
```
TODO (code): `grace_embed_server.py` (fastembed, CPU) exposing `POST /embed`; repoint
`semanticMemory.embed()` at `GRACE_EMBED_URL` (falls back to Ollama). One-time memory re-index
after switching (dimension change). e5 needs `"query: "`/`"passage: "` prefixes.

## 4. TTS → keep Kokoro (English) + add Danish ⏳ (needs Danish TTS server)
Kokoro-82M stays the English voice (already wired; `en` mode works today). Danish is now viable
locally, so Grace can reply in Danish.
- **Simplest / zero-GPU:** Piper `da_DK-talesyntese-medium` (download the `.onnx` + `.onnx.json`
  from rhasspy/piper voices).
- **Best quality (~2–4GB GPU):** CoRal `roest-v3-chatterbox-500m` (native MOS 4.23).

TODO (code): a Danish TTS server exposing the **same** `/synthesize` + `/speak` API as
`grace_kokoro_server.py`; point `GRACE_TTS_DA_URL` at it. Then `GRACE_DEFAULT_LANGUAGE=da` to make
Danish the at-home default (English stays one "switch to English" away).

## Status — done 2026-07-19 (models downloaded + wired; needs a live voice test)
- [x] **Røst-v3 → OpenVINO converted** (`models/ov-roest-v3-whisper-1.5b-fp16`) and set ACTIVE in `start-grace.ps1` (`GRACE_OV_MODEL`). Fallback to large-v3 is one line away. **Live-test Danish incl. Ja/Nej.**
- [x] **Danish TTS**: Piper voice downloaded (`models/piper/`), `grace_da_tts_server.py` built (same API as Kokoro), launched by `start-grace.ps1`, `GRACE_TTS_DA_URL` set, and `GRACE_DEFAULT_LANGUAGE=da`. English stays one "switch to English" away.
- [x] **Embedder**: `grace_embed_server.py` (fastembed) + `intfloat/multilingual-e5-large` downloaded; `embed()` is pluggable via `GRACE_EMBED_URL`. **Left OFF by default** in the launcher because e5-large is 1024-dim vs nomic's 768 — enabling it needs a one-time Chroma reset first: `docker compose -f docker/chroma/docker-compose.yml down -v`, then uncomment the two lines in `start-grace.ps1`.
- [ ] Optional: `gemma4:12b` if 26B leaves too little headroom for normal PC use.

**First live run:** the STT model + reply-language + Danish voice all change at once, so validate on your voice (esp. Ja/Nej). If Røst misbehaves on the Arc iGPU, swap `GRACE_OV_MODEL` back to large-v3.

## Env vars (already read by the code)
`GRACE_OV_MODEL`, `GRACE_WHISPER_LANG`, `GRACE_EMBED_MODEL`/`GRACE_EMBED_URL`, `GRACE_TTS_DA_URL`,
`GRACE_TTS_DA_VOICE`, `GRACE_DEFAULT_LANGUAGE`, `GRACE_SEARCH_URL` (SearXNG), `GRACE_REPO_ROOT`.
