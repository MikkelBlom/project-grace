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

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { bus } from '@grace/core';

const execAsync = promisify(exec);

const KOKORO_URL = process.env.GRACE_KOKORO_URL   ?? 'http://localhost:8765';
const VOICE      = process.env.GRACE_KOKORO_VOICE ?? 'af_heart';
const SPEED      = parseFloat(process.env.GRACE_KOKORO_SPEED ?? '1.0');
// 'server' = server synthesizes AND plays via a persistent stream (smoother over Bluetooth).
// 'powershell' (default) = fetch WAV + play per-clip via PowerShell SoundPlayer.
const PLAYBACK   = process.env.GRACE_TTS_PLAYBACK ?? 'powershell';
const TEMP_DIR   = path.join(tmpdir(), 'grace-tts');

// ─────────────────────────────────────────────

export class KokoroTTS {
  private isAvailable = false;
  private queue: Array<{ text: string; sessionId: string }> = [];
  private isSpeaking = false;

  constructor() {
    this.ensureTempDir();
    this.setupListeners();
    this.checkAvailability();
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
      this.queue.push({ text, sessionId });
      if (!this.isSpeaking) this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    let lastSession = '';
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      lastSession = item.sessionId;
      await this.speak(item.text);
    }
    this.isSpeaking = false;
    // Emit tts:done ONCE, when the whole turn has drained — supports streamed sentences.
    if (lastSession) bus.emit('tts:done', { sessionId: lastSession });
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
    if (PLAYBACK === 'server') {
      // Server synthesizes AND plays via a persistent stream — no per-clip spawn.
      const r = await fetch(`${KOKORO_URL}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: VOICE, speed: SPEED }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`TTS server /speak HTTP ${r.status}`);
      return;
    }
    const res = await fetch(`${KOKORO_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: VOICE, speed: SPEED }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) throw new Error(`TTS server HTTP ${res.status}`);

    const wavBuffer = Buffer.from(await res.arrayBuffer());
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
    const { stdout, stderr } = await execAsync(
      `powershell -NoProfile -EncodedCommand ${encoded}`,
      { timeout: 30_000 },
    );
    if (stdout?.trim()) console.log('[KokoroTTS]', stdout.trim());
    if (stderr?.trim()) console.warn('[KokoroTTS] SAPI stderr:', stderr.trim());
  }

  // ── Playback ─────────────────────────────────

  private async playWav(wavPath: string): Promise<void> {
    const winPath = wavPath.replace(/\//g, '\\');
    const script  = `(New-Object Media.SoundPlayer '${winPath.replace(/'/g, "''")}').PlaySync()`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`, { timeout: 60_000 });
  }

  isOnline(): boolean { return this.isAvailable; }
}
