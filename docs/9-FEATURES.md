# Grace — Features Tracker

Status of the major features. ✅ implemented · 🟡 partial/opt-in · ⏳ needs live test · ⬜ planned.

## Core pipeline
| Feature | Status | Notes |
|---|---|---|
| Voice loop (STT→LLM→TTS) | ✅ | OpenVINO Whisper (Arc) → gemma4:26b → Kokoro |
| Text input mode | ✅ | `GRACE_TEXT_INPUT=1`, type via console |
| Language mode (DA⇄EN) | ✅ | `set_language` + voice; reply + TTS follow |
| Barge-in / interrupt | ✅ | hotkeys + voice fast-path |
| isProcessing watchdog | ✅ | can't go deaf on a stuck turn |

## Retrieval & knowledge
| Feature | Status | Notes |
|---|---|---|
| SearXNG-first web search + fallbacks | ✅ | Tavily/Brave (keyed) → SearXNG → DuckDuckGo |
| research (grounded, self-verifying) | ✅ | search→read→source-check→confidence |
| fact_check | ✅ | verdict + evidence on a claim |
| Query router (fast-path vs research) | ✅ | zero-cost heuristic hint |
| wikipedia / define / translate / weather_forecast | ✅ | |

## Memory
| Feature | Status | Notes |
|---|---|---|
| Semantic memory (Chroma + sqlite) | ✅ | single shared instance, graceful fallback |
| Token-budgeted history + rolling summary | ✅ | 128k ctx |
| Off-GPU embedder (e5) | 🟡 | pluggable `GRACE_EMBED_URL`; needs Chroma re-index |
| Consolidate / browse memory | ✅ | dedup + review tools |

## STT accuracy & safety
| Feature | Status | Notes |
|---|---|---|
| Danish STT fine-tune (Røst) | ⏳ | wired, needs live voice test |
| Post-ASR correction dictionary | ✅ | voice-teachable (`add_stt_correction`) |
| Ja/Nej confidence gate + default-deny | ✅ | needs threshold tuning on real audio |
| Dynamic contextual STT bias | 🟡 | opt-in `GRACE_STT_DYNAMIC_BIAS` |

## TTS
| Feature | Status | Notes |
|---|---|---|
| English voice (Kokoro) | ✅ | |
| Danish voice (Piper) | ⏳ | wired, needs live test |
| Streaming (sentence-chunk) | 🟡 | opt-in `GRACE_TTS_STREAM` |

## Filesystem, tools, modes
| Feature | Status | Notes |
|---|---|---|
| Whole-disk file index (voice-configurable) | ✅ | `find_file`, add/remove roots, watcher |
| Content search / recent / duplicates / disk usage | ✅ | |
| System status / processes / git inspect | ✅ | |
| Notes / to-dos / draft email / journal | ✅ | draft_email never sends |
| Deep Work timer / eye-pause / mood / story | ✅ | the vision-doc modes, as tools |
| Self-development (create_tool, missions) | ✅ | Docker sandbox |
| Vision (screenshot, analyze_screen, focus_box) | ✅ | gemma4 box_2d |

## Infra & quality
| Feature | Status | Notes |
|---|---|---|
| Unit + smoke tests (`npm run test`/`smoke`) | ✅ | |
| Eval harness (`npm run eval`) | ✅ | latency + correctness |
| Per-turn timing instrumentation | ✅ | `[timing]` logs |
| Startup config validation | ✅ | |

## Not yet built
- Reasoning-model A/B via the eval harness (decide after a baseline run)
- `gemma4:12b` fallback if 26B crowds normal PC use
- Continuous screen narration; `inject_text`; MCP client; image generation (Flux)
