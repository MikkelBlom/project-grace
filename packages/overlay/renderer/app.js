// ─────────────────────────────────────────────
// Grace HUD — renderer process
// State machine that drives all visual output
// ─────────────────────────────────────────────

const pill        = document.getElementById('pill');
const userBubble  = document.getElementById('user-bubble');
const graceBubble = document.getElementById('grace-bubble');
const graceText   = document.getElementById('grace-text');
const dots        = document.getElementById('dots');
const notif       = document.getElementById('notification');

let bubbleTimer  = null;
let notifTimer   = null;
let currentState = 'idle';

// ── State machine ──────────────────────────────

const STATES = [
  'idle','listening','thinking','speaking','discreet','brainstorm',
  'meeting','autopilot','field-notes','paused',
];

function setState(state) {
  if (currentState === state) return;
  STATES.forEach(s => pill.classList.remove(`state-${s}`));
  pill.classList.add(`state-${state}`);
  currentState = state;
  syncWindowSize();
}

// ── Markdown renderer ──────────────────────────

function renderMarkdown(text) {
  const esc = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const parts = text.split(/(```[\s\S]*?```)/g);

  return parts.map(part => {
    if (part.startsWith('```')) {
      const match = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
      const lang = match?.[1] ?? '';
      const code = match?.[2] ?? part.slice(3, -3);
      return [
        '<div class="code-block">',
        lang ? `<div class="code-lang">${esc(lang)}</div>` : '',
        `<pre><code>${esc(code.trimEnd())}</code></pre>`,
        '</div>',
      ].join('');
    }

    let s = esc(part);
    s = s.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }).join('');
}

// ── Bubble helpers ─────────────────────────────

function showUserBubble(text) {
  userBubble.textContent = text;
  userBubble.classList.remove('hidden');
  userBubble.style.animation = 'none';
  requestAnimationFrame(() => { userBubble.style.animation = ''; });
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideAll, 12000);
  syncWindowSize();
}

function showThinking() {
  graceBubble.classList.remove('hidden');
  dots.classList.remove('hidden');
  graceText.innerHTML = '';
  syncWindowSize();
}

function showGraceText(text) {
  dots.classList.add('hidden');
  graceText.innerHTML = renderMarkdown(text);
  graceBubble.classList.remove('hidden');
  graceBubble.style.animation = 'none';
  requestAnimationFrame(() => { graceBubble.style.animation = ''; });
  clearTimeout(bubbleTimer);

  const words = text.split(/\s+/).length;
  const readTime = Math.max(6000, Math.min(words * 350, 30000));
  bubbleTimer = setTimeout(hideAll, readTime);
  syncWindowSize();
}

function hideAll() {
  userBubble.classList.add('hidden');
  graceBubble.classList.add('hidden');
  dots.classList.add('hidden');
  graceText.innerHTML = '';
  syncWindowSize();
}

// ── Notification helper ───────────────────────

function showNotification(text, level = 'info', duration = 4000) {
  notif.textContent = text;
  notif.className = level !== 'info' ? level : '';
  notif.classList.remove('hidden');
  notif.style.animation = 'none';
  requestAnimationFrame(() => { notif.style.animation = ''; });
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => notif.classList.add('hidden'), duration);
  syncWindowSize();
}

// ── Window sizing ──────────────────────────────

function syncWindowSize() {
  requestAnimationFrame(() => {
    const pillH   = 44;
    const gap     = 6;
    const padding = 20;

    const userH  = userBubble.classList.contains('hidden')  ? 0 : userBubble.offsetHeight  + gap;
    const graceH = graceBubble.classList.contains('hidden') ? 0 : graceBubble.offsetHeight + gap;
    const notifH = notif.classList.contains('hidden')       ? 0 : notif.offsetHeight       + gap;

    const totalH     = pillH + userH + graceH + notifH + padding;
    const hasContent = userH + graceH + notifH > 0;

    window.grace?.resize(400, totalH);
    window.grace?.setClickThrough(!hasContent);
  });
}

// ── Main event handler ─────────────────────────

function handleStateUpdate(data) {
  switch (data.type) {

    case 'listening':
      setState('listening');
      break;

    case 'heard':
      setState('thinking');
      showUserBubble(data.text);
      showThinking();
      break;

    case 'thinking':
      setState('thinking');
      showThinking();
      break;

    case 'speaking':
      setState('speaking');
      showGraceText(data.text);
      break;

    case 'idle':
      setState('listening');
      break;

    case 'discreet':
      setState('discreet');
      hideAll();
      showNotification('🔒 Diskret Mode — nul data gemmes', 'info', 4000);
      break;

    case 'normal':
      setState('listening');
      showNotification('✓ Diskret Mode afsluttet', 'info', 2000);
      break;

    case 'brainstorm':
      setState('brainstorm');
      showNotification('💭 Brainstorm Mode — lytter uden afbrydelse. Sig "hvad synes du?" for analyse.', 'info', 6000);
      break;

    case 'meeting':
      setState('meeting');
      showNotification('📋 Møde-mode aktiv — noterer...', 'info', 4000);
      break;

    case 'field-notes':
      setState('field-notes');
      hideAll();
      showNotification('📓 Field Notes Mode — lytter passivt, ingen AI', 'info', 5000);
      break;

    case 'paused':
      setState('paused');
      hideAll();
      break;

    case 'notification':
      showNotification(data.text, data.level ?? 'info', data.duration ?? 4000);
      break;

    default:
      console.warn('[Grace HUD] Unknown state update:', data.type);
  }
}

// ── Boot ───────────────────────────────────────

if (window.grace) {
  // Real mode: connected to Electron IPC
  console.log('[Grace HUD] IPC bridge ready — connecting to Grace backend');
  window.grace.onStateUpdate(handleStateUpdate);
  setState('idle');
  showNotification('Grace starter...', 'info', 3000);
} else {
  // No IPC — show diagnostic state so it's obvious something is wrong
  console.warn('[Grace HUD] window.grace is undefined — preload not loaded?');
  setState('idle');
  showNotification('⚠ Ingen IPC — preload fejlede. Tjek DevTools.', 'warning', 30000);
}
