# Grace — Ideas (next backlog)

75 fresh ideas, beyond the now-completed docs/7 backlog. Numbered by category.

## A. Voice & audio intelligence
1. Speaker verification — only respond to Mikkel's voice (NPU).
2. Acoustic echo cancellation / denoise (NPU) so barge-in works on speakers.
3. Emotion/prosody detection from voice → adapt Grace's tone.
4. Expressive / emotional TTS (prosody control).
5. Cloned custom "Grace" voice (Chatterbox, 5-sec sample).
6. Real-time streaming STT (partial transcripts) for lower latency.
7. Multi-speaker diarization in meetings ("who said what").
8. Per-utterance language auto-detect → auto-switch DA/EN mode.
9. Ambient sound classification (doorbell, phone, alarm) → notify.
10. "Privacy hush" gesture/word to fully mute for a while.

## B. Vision & screen
11. Continuous screen-narration mode (describe what changes).
12. `get_mouse_context` — read the UI element under the cursor (UIA).
13. `inject_text` — type into the active app (nut.js).
14. OCR fallback for image-only screenshots.
15. Visual diff — "what changed on my screen?".
16. Auto-detect error dialogs and offer fixes.
17. Screen-region watch — alert when a value/element changes.
18. Read + summarize the document/PDF currently on screen.

## C. Retrieval & knowledge
19. RSS/news subscriptions + a morning digest.
20. Local document RAG (index Mikkel's PDFs/notes into Chroma).
21. Confidence badges on answers in the HUD.
22. Multi-hop research (auto follow-up queries).
23. Persistent research knowledge base (reuse past answers).
24. Stock / crypto price watch (read-only).
25. Package / shipment tracking.
26. Academic paper search (arXiv / Semantic Scholar).
27. Code/docs lookup (MDN, language references).

## D. Productivity & personal
28. Calendar integration (CalDAV) — read + draft events.
29. Email triage — read-only summaries + draft replies.
30. Natural-language reminders ("næste tirsdag kl. 14").
31. Habit tracking + streaks.
32. Weekly review generator (todos + notes + mood → recap).
33. Productivity-curve visualization (focus sessions over time).
34. Meeting prep briefs (context on topics/attendees).
35. Contact briefs (who is this, last interactions).
36. Voice-driven spreadsheet / data entry.

## E. Developer experience
37. `run_command` — sandboxed, allowlisted shell actions.
38. `generate_commit_msg` from the working diff.
39. Run tests / build on command + report failures aloud.
40. `docker_doctor` — diagnose container issues.
41. Code review of a diff (lint + suggestions).
42. Inject a snippet into the terminal/editor.
43. Watch CI status + notify on failure.
44. Project scaffolding ("new TS package", "new tool").

## F. Memory & learning
45. Episodic memory — "what did we do last Tuesday?".
46. Auto-extract preferences from conversation → profile.
47. Knowledge graph of people / projects / topics.
48. Importance-weighted memory decay.
49. "Teach me" mode — Grace explains, then quizzes.
50. Cross-session goal tracking + nudges on stalled goals.

## G. Modes & wellbeing
51. Adaptive Deep Work — auto-extend on detected flow (typing/app signals).
52. Energy/mood auto-inference (typing speed, app switches).
53. Music mood-match (Spotify / VLC by detected mood).
54. Posture / hydration reminders.
55. Evening wind-down mode (dim overlay, softer voice).
56. Gaming companion mode (low-latency HUD, no interruptions).
57. True discreet/whisper TTS (low volume, HUD-only).

## H. Model & performance
58. A/B reasoning models through the eval harness (qwen3.6 vs gemma4).
59. Draft-model speculative acks ("let me check…" instantly).
60. Move Whisper/embeddings onto the NPU to free more RTX.
61. Keep the LLM KV-cache warm across turns.
62. Per-request model routing (tiny model for chit-chat).
63. Q5 quantization experiments once VRAM frees up.

## I. UX & platform
64. HUD chat-transcript view (scrollback of the conversation).
65. Focus-timer countdown widget in the overlay.
66. Mobile companion (view/notify from phone).
67. Global hotkey to type a quick command to Grace.
68. Smarter multi-monitor routing.
69. Themeable overlay.
70. Notification center for Grace's proactive alerts.

## J. Integrations & safety
71. MCP client — connect to external MCP servers.
72. Home automation (Home Assistant) voice control.
73. Encrypted secrets vault for API keys.
74. Audit log of all mutating actions + undo history.
75. Per-tool permission profiles (what Grace may do unattended).
