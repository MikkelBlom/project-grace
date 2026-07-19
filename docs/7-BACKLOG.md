# Grace — Autonomous Backlog

Self-contained work items Claude can build + validate headlessly (build-green + unit/smoke tests).
Risky/behavior-changing items are feature-flagged or scaffolded; anything needing live voice/audio
validation is marked ⚠live. Model downloads (Røst STT, e5 embedder, Danish TTS — see 6-MODEL-UPGRADES.md)
are intentionally NOT here — they need bandwidth + a live test.

## A. Testing & quality infrastructure (first — protects everything)
- [ ] Dep-free unit suite (`node:test`): entity-decode/HTML-extract, parseLanguage, STT corrections, TTS splitter, router, fsIndex search, token estimate
- [ ] `npm run test` + `npm run smoke` (load all tools, assert registry non-empty, no crashes)
- [ ] Expand eval/prompts.json (edge cases, more categories)

## B. File & content tools
- [ ] search_content (grep-in-files — content, not just names)
- [ ] read_document (PDF/text extraction)
- [ ] summarize_file (LLM summary of a file)
- [ ] file_info / preview (size, mtime, type, head)
- [ ] recent_files (recently modified across indexed roots)
- [ ] disk_usage (folder sizes)
- [ ] duplicate_finder

## C. Knowledge & web tools
- [ ] wikipedia lookup
- [ ] define (dictionary)
- [ ] weather_forecast (multi-day; get_weather is current-only)
- [ ] translate (da<->en via LLM)
- [ ] currency_convert (live rates)
- [ ] fact_check (standalone verify)
- [ ] calculate (safe expression eval)

## D. Productivity & personal
- [ ] notes capture + list_notes (persisted)
- [ ] todo add/list/complete (persisted)
- [ ] reminder / timer (general, beyond focus)
- [ ] draft_email (compose to file, NEVER sends)
- [ ] voice_journal
- [ ] daily_brief

## E. System & dev
- [ ] system_status (CPU/RAM/GPU/disk/battery)
- [ ] list_processes / active_apps
- [ ] git_status / git_log (read-only repo inspection)
- [ ] run_command (sandboxed, allowlisted — careful)

## F. Harness & retrieval
- [ ] Parallelize research fetches (currently sequential)
- [ ] Search result de-dup + date/domain filters
- [ ] fetch_url PDF support
- [ ] Research URL cache
- [ ] Pluggable search-provider registry (Tavily/Brave adapters ready)

## G. Memory & context
- [ ] Pluggable embedder via GRACE_EMBED_URL (code ready for the e5 server)
- [ ] Debounced/append journal writes (fix O(n^2) whole-file rewrite)
- [ ] Memory-browse tool (list recent memories)
- [ ] Memory consolidation / dedup
- [ ] Fix semanticEngine telemetry (report real chroma/local state)

## H. Reliability & cleanup
- [ ] Remove dead chat()/chatStream() in OllamaLLM
- [ ] DRY extractAbsolutePaths
- [ ] Startup config validation
- [ ] Error-handling audit

## I. UX & modes (some ⚠live)
- [ ] Text-input mode (type to Grace) — long-wanted
- [ ] On-demand meeting summary
- [ ] Story/creative mode ⚠live
- [ ] Eye-pause 20-20-20 ⚠live
- [ ] Energy/mood tracker
- [ ] Focus-timer countdown in overlay ⚠live

## J. Docs & tracking
- [ ] Update stale 3-TOOLS.md
- [ ] Architecture mermaid diagram
- [ ] FEATURES tracker
