// ─────────────────────────────────────────────
// KokoroTTS -- Phase 1 TTS implementation
//
// Connects to grace_kokoro_server.py (Piper TTS / Kokoro backend)
// running as a local Windows Python process.
// Sends text via HTTP POST, receives WAV audio, plays via PowerShell.
//
// All TTS runs 100% offline -- no internet required.
//
// Start the server before launching Grace:
//   py -3.12 grace_kokoro_server.py --port 8765
//
// Env config:
//   GRACE_KOKORO_URL=http://localhost:8765
//   GRACE_KOKORO_VOICE=da_DK-talesyntese-medium   (Piper da-DK voice)
//   GRACE_KOKORO_SPEED=1.0
// ─────────────────────────────────────────────

import { spawn, type ChildProcess } from 'child_process';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { bus, settings, logTiming } from '@grace/core';
import { splitForTTS } from './ttsChunk.js';

const KOKORO_URL = process.env.GRACE_KOKORO_URL   ?? 'http://localhost:8765';
const VOICE      = process.env.GRACE_KOKORO_VOICE ?? 'af_heart';
const SPEED      = parseFloat(process.env.GRACE_KOKORO_SPEED ?? '1.0');
// Danish TTS backend (Piper/CoRal), exposing the SAME /synthesize + /speak API as Kokoro. Empty
// until wired — in Danish mode without it, we fall back to the English voice (and warn once).
const DA_TTS_URL = process.env.GRACE_TTS_DA_URL   ?? '';
const DA_VOICE   = process.env.GRACE_TTS_DA_VOICE ?? 'da_DK';
// 'server' = server synthesizes AND plays via a persistent stream (smoother over Bluetooth).
// 'powershell' (default) = fetch WAV + play per-clip via PowerShell SoundPlayer.
const PLAYBACK   = process.env.GRACE_TTS_PLAYBACK ?? 'powershell';
const TEMP_DIR   = path.join(tmpdir(), 'grace-tts');
// Sentence-streaming: synthesise the (short) first sentence and start audio before the whole reply
// is synthesised — lower first-audio latency. Off by default (per-clip playback dropped over
// Bluetooth); enable with GRACE_TTS_STREAM=1, and it's automatic with the persistent server stream.
const STREAMING  = process.env.GRACE_TTS_STREAM === '1' || PLAYBACK === 'server';

// ─────────────────────────────────────────────

export class KokoroTTS {
  private isAvailable = false;
  private queue: Array<{ text: string; sessionId: string }> = [];
  private isSpeaking = false;
  /** The PowerShell playback child for the clip currently playing, so a stop can kill it mid-sentence. */
  private currentChild: ChildProcess | null = null;
  /** Set when a stop is requested so an in-flight synth/play resolves quietly instead of continuing. */
  private stopRequested = false;
  private warnedNoDanish = false;

  /** Pick the TTS endpoint + voice for the ACTIVE language. Danish routes to GRACE_TTS_DA_URL
   *  when configured; otherwise falls back to the English Kokoro voice (warned once). */
  private ttsTarget(): { url: string; voice: string } {
    if (settings.language === 'da') {
      if (DA_TTS_URL) return { url: DA_TTS_URL, voice: DA_VOICE };
      if (!this.warnedNoDanish) {
        console.warn('[KokoroTTS] Danish mode but no GRACE_TTS_DA_URL — using the English voice. Wire the Danish TTS backend for natural Danish speech.');
        this.warnedNoDanish = true;
      }
    }
    return { url: KOKORO_URL, voice: VOICE };
  }

  constructor() {
    this.ensureTempDir();
    this.setupListeners();
    this.checkAvailability();
  }

  // ── Barge-in: stop speaking NOW and drop the queue ──
  stop(): void {
    this.stopRequested = true;
    this.queue = [];
    if (this.currentChild) {
      try { this.currentChild.kill('SIGTERM'); } catch { /* already gone */ }
      this.currentChild = null;
    }
    if (this.isSpeaking) {
      this.isSpeaking = false;
      console.log('[KokoroTTS] ⏹ speech stopped (barge-in)');
      // Let the mic come back immediately — GraceCore resumes STT on tts:done.
      bus.emit('tts:done', { sessionId: 'stopped' });
    }
  }

  private async ensureTempDir(): Promise<void> {
    await mkdir(TEMP_DIR, { recursive: true });
  }

  // ── Availability check ───────────────────────

  private async checkAvailability(): Promise<void> {
    try {
      const res = await fetch(`${KOKORO_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const info = await res.json() as { engine?: string; voice?: string };
        this.isAvailable = true;
        const engine = info.engine ?? 'unknown';
        const voice  = info.voice  ?? VOICE;
        console.log(`[KokoroTTS] Server online -- engine: ${engine}, voice: ${voice}`);
        bus.emit('overlay:notification', {
          text: `TTS klar (${engine})`,
          level: 'info', duration: 3000,
        });
      }
    } catch {
      console.warn('[KokoroTTS] TTS server ikke tilgaengelig paa ' + KOKORO_URL);
      console.warn('[KokoroTTS]   Start: py -3.12 grace_kokoro_server.py --port 8765');
      console.warn('[KokoroTTS]   Falder tilbage til Windows SAPI (ringe stemmekvalitet)');
      bus.emit('overlay:notification', {
        text: 'TTS: SAPI fallback (start grace_kokoro_server.py for dansk stemme)',
        level: 'warning', duration: 6000,
      });
    }
  }

  // ── EventBus listener ────────────────────────

  private setupListeners(): void {
    bus.on('tts:speaking', ({ text, sessionId }) => {
      this.stopRequested = false;   // a fresh utterance clears any prior stop latch
      // Stream in sentence chunks (first audio sooner) when enabled; otherwise one clip (the
      // Bluetooth-safe default). The queue plays them in order and emits a single tts:done.
      if (STREAMING && text.length > 60) {
        for (const chunk of splitForTTS(text)) this.queue.push({ text: chunk, sessionId });
      } else {
        this.queue.push({ text, sessionId });
      }
      if (!this.isSpeaking) this.processQueue();
    });
    bus.on('tts:stop', () => this.stop());
    bus.on('control:stop', () => this.stop());
  }

  private async processQueue(): Promise<void> {
    let lastSession = '';
    while (this.queue.length > 0) {
      if (this.stopRequested) break;   // barge-in: abandon the rest of the queue
      const item = this.queue.shift();
      if (!item) break;
      lastSession = item.sessionId;
      await this.speak(item.text);
    }
    this.isSpeaking = false;
    // Emit tts:done ONCE, when the whole turn has drained — supports streamed sentences.
    // If a stop already fired, stop() emitted tts:done, so don't emit a duplicate.
    if (lastSession && !this.stopRequested) bus.emit('tts:done', { sessionId: lastSession });
  }

  // ── Core synthesis + playback ────────────────

  private async speak(text: string): Promise<void> {
    this.isSpeaking = true;
    const engine = this.isAvailable ? 'Kokoro' : 'SAPI';
    console.log(`[KokoroTTS] [${engine}] Speaking...`);

    try {
      if (this.isAvailable) {
        await this.speakViaServer(text);
      } else {
        await this.speakViaSAPI(text);
      }
      console.log('[KokoroTTS] Done.');
    } catch (err) {
      console.error('[KokoroTTS] Speech error:', err);
    }
  }

  // ── TTS server (Piper / Kokoro) ──────────────

  private async speakViaServer(text: string): Promise<void> {
    const target = this.ttsTarget();
    if (PLAYBACK === 'server') {
      // Server synthesizes AND plays via a persistent stream — no per-clip spawn.
      const r = await fetch(`${target.url}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: target.voice, speed: SPEED }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`TTS server /speak HTTP ${r.status}`);
      return;
    }
    const synthT0 = Date.now();
    const res = await fetch(`${target.url}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: target.voice, speed: SPEED }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) throw new Error(`TTS server HTTP ${res.status}`);

    const wavBuffer = Buffer.from(await res.arrayBuffer());
    logTiming('tts.synth', Date.now() - synthT0, { chars: text.length, lang: settings.language });
    const wavPath   = path.join(TEMP_DIR, `tts-${Date.now()}.wav`);
    await writeFile(wavPath, wavBuffer);
    await this.playWav(wavPath);
    unlink(wavPath).catch(() => {});
  }

  // ── SAPI fallback (last resort) ──────────────
  // Tries to find an installed Danish SAPI voice.
  // Install one: Windows Settings > Time & Language > Speech > Add voices > da-DK

  private async speakViaSAPI(text: string): Promise<void> {
    console.log(`[KokoroTTS] SAPI -> "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`);
    const safeText = text.replace(/'/g, "''");
    const script = `Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$danish = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'da*' } | Select-Object -First 1
if ($danish) {
  $synth.SelectVoice($danish.VoiceInfo.Name)
  Write-Host "[SAPI] Dansk stemme: $($danish.VoiceInfo.Name)"
} else {
  Write-Host "[SAPI] Ingen dansk stemme -- standard: $($synth.Voice.Name)"
}
$synth.Rate = 2
$synth.Speak('${safeText}')`;

    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    // Via the killable spawn helper so SAPI speech can be barged-in too (output not captured here).
    await this.runPowershellEncoded(encoded, 30_000);
  }

  // ── Playback ─────────────────────────────────

  private async playWav(wavPath: string): Promise<void> {
    const winPath = wavPath.replace(/\//g, '\\');
    const script  = `(New-Object Media.SoundPlayer '${winPath.replace(/'/g, "''")}').PlaySync()`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    await this.runPowershellEncoded(encoded, 600_000);
  }

  // Spawn PowerShell and keep the child handle so a barge-in stop() can kill playback
  // mid-clip. Resolves on exit (or after the timeout, or if killed) — never rejects, so
  // the queue drains cleanly whether speech finished or was interrupted.
  private runPowershellEncoded(encoded: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn('powershell', ['-NoProfile', '-EncodedCommand', encoded], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      this.currentChild = child;
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        if (this.currentChild === child) this.currentChild = null;
        resolve();
      };
      child.on('close', finish);
      child.on('error', (e) => { console.warn('[KokoroTTS] playback spawn error:', e); finish(); });
    });
  }

  isOnline(): boolean { return this.isAvailable; }
}
