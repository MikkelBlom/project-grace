import { registerTool } from '../registry.js';

// "Hold the floor" listen mode, triggered semantically by Grace herself. The actual state
// switch is handled in the LLM layer (it has the EventBus) — calling this tool signals that
// intent, and the loop emits control:listenMode. Grace decides WHEN to call it: only when
// Mikkel clearly wants to talk uninterrupted. If she's unsure, she should ASK first and call
// this only after he confirms.
registerTool({
  name: 'enter_listen_mode',
  description: 'Go quiet and just LISTEN while Mikkel explains something long or complex across pauses, until he says he is done — then answer the whole thing at once. Call this when Mikkel signals he wants to hold the floor / talk uninterrupted (e.g. "slå lyttelapperne ud", "lad mig forklare", "bare lyt, jeg har en lang idé"). If you are NOT sure he means it, do NOT call this yet — first ASK ("Vil du have jeg bare lytter, til du er klar?") and only call it after he says yes.',
  params: {},
  async run() { return { ok: true, listening: true }; },
});
