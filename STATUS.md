# Grace — STATUS

_Updated: 2026-06-03 · RTX 5090 Laptop (24 GB), 64 GB RAM, Win 11 · git: main_

## Goal
Foundational structure usable for real, then build on top → eventually self-expanding.

## Version control ✅ (new)
- `git init` done. Commits: `2a5f35e` (foundation), `510d392` (tooling upgrade).
- `.gitignore` excludes node_modules / dist / models / data / logs / compiled output.
- No remote yet — add a GitHub remote + `git push -u origin main` when ready.

## Working & verified ✅
- I/O loop: Whisper `large-v3` (GPU) → `gemma4:26b` (think:false) → Kokoro TTS
  (`af_heart`, **GPU** via torch cu128). Speak Danish → reply English.
- **Multi-step agentic tools (new, verified):** OllamaLLM runs a ReAct loop (≤5 steps) —
  chains tool calls, reads results, **self-corrects** (e.g. "overførsler" → searches
  "Downloads"), nudges instead of going silent on empty replies, answers only when it has
  the info. Verified end-to-end: listed real Downloads contents.
- **search_files (new):** matches FOLDERS + files; empty query lists top level; bare/`home`/`~`
  roots resolve under home. (Was file-only before — couldn't find folders at all.)
- `<SKIP>` tightened: only true backchannel ("ok"/"mmm"); greetings/questions/requests never skipped.
- Tools: get_weather, get_location, search_files, web_search (real URLs). Personality-as-data,
  anti-fabrication, cross-session persistence (JSON; node:sqlite absent in Electron → fallback).

## Deferred (with reasons)
- **Promote tools → packages/tools** — needs `npm install` to link the new workspace + a
  build-order fix (tools must `tsc` before llm; npm builds alphabetically so it'd come after).
  Steps for next time: create packages/tools/{package.json,tsconfig.json,src/index.ts} (composite,
  exclude electron `ui-self-test.ts`); add `@grace/tools` dep + reference in llm; change
  OllamaLLM import to `@grace/tools`; prepend `npm run build -w packages/tools` to root build;
  `npm install`; rebuild. Not done to avoid destabilising the working build on a low budget.
- TTS smoothness: GPU helped; per-clip PowerShell playback spawn is the last bit (persistent player).
- Minor: startup recall can surface junk (last session it greeted with a swear word — filter <20 chars).
- GPS location vs IP; calendar tool (OAuth); deeper file search via Windows index.

## Run
`cd grace ; .\start-grace.ps1`  (Buds4 for mic = mono output; use `GRACE_MIC_NAME="Realtek"` for stereo).
Try: "kig i min overførsler-mappe", "find filer der hedder X", weather, web search.

## Next session
1. Promote tools → packages/tools (steps above). 2. Persistent audio player. 3. More tools + GPS.
