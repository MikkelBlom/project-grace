# start-grace.ps1 - Grace Phase 1 launcher
# Starter Kokoro TTS i baggrunden og launcher Grace.
# Rydder automatisk op naar Grace lukkes.

$graceRoot = $PSScriptRoot

# --- Konfiguration ---
$env:GRACE_LLM_PROVIDER  = "ollama"
$env:GRACE_STT_PROVIDER  = "whisper"
$env:GRACE_TTS_PROVIDER  = "kokoro"
# Smoother audio over Bluetooth: server synthesizes AND plays via a persistent stream
# (no per-clip PowerShell spawn). Uncomment to try; re-comment to revert if worse:
# $env:GRACE_TTS_PLAYBACK = "server"
$env:GRACE_LLM_MODEL     = "gemma4:26b"
$env:GRACE_WHISPER_MODEL = "large-v3"
$env:GRACE_WHISPER_LANG  = "da"
$env:GRACE_PYTHON_CMD    = "py"

# --- STT backend -----------------------------------------------------------
# 'openvino' runs Whisper on the Intel Arc iGPU (GPU.0), freeing ~3GB on the RTX
# so gemma4:26b stops thrashing. 'faster-whisper' = old CUDA path (fallback).
$env:GRACE_STT_BACKEND   = "openvino"
# Which converted model the OpenVINO backend loads:
#   ...-turbo-fp16 = sub-700ms, accuracy ~= old CUDA   (recommended)
#   ...-large-v3-fp16 = ~1.8s, best accuracy
$env:GRACE_OV_MODEL      = "$graceRoot\models\ov-whisper-large-v3-turbo-fp16"
$env:GRACE_OV_DEVICE     = "GPU.0"
# Beam search width. KEEP AT 1: beams>1 is NOT implemented on the Arc iGPU
# (OpenVINO GPU plugin throws "Not Implemented" at generate time). Accuracy gains
# must come from denoise / contextual-bias / a better mic, not beams.
$env:GRACE_OV_NUM_BEAMS  = "1"

# --- Mikrofon-valg ---------------------------------------------------------
# GRACE_MIC_NAME = del af enhedsnavnet (case-insensitivt). Tom "" = Windows default.
# !! BLUETOOTH: bruger man Buds4 som MIKROFON, tvinger Windows dem i "headset"-tilstand
#    (HFP) = MONO, kun den ene oeretelefon, lav kvalitet. Stereo (A2DP) kommer foerst
#    tilbage naar mikrofonen slippes (derfor spiller YouTube fint bagefter).
#   "Realtek" = laptop-mik -> Buds4 forbliver STEREO til output  (anbefalet hvis mono generer)
#   "Buds4"   = bedste mik-praecision, MEN mono-output i begge oerer (BT-begraensning)
#   "VF0700"  = webcam-mik (daarligst)
$env:GRACE_MIC_NAME      = "Realtek"

Write-Host ""
Write-Host "[Grace] Starting up..." -ForegroundColor Cyan

# --- Ensure Ollama is running (the LLM backend) ---
# Without this, Grace launches fine but every reply silently hangs waiting for an
# Ollama that isn't there. Start it ourselves if the API isn't already answering.
function Test-Ollama {
    try { (Invoke-WebRequest -Uri 'http://localhost:11434/api/version' -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200 }
    catch { $false }
}
if (Test-Ollama) {
    Write-Host "[Ollama] Already running." -ForegroundColor Gray
} else {
    Write-Host "[Ollama] Not running -- starting 'ollama serve' in background..." -ForegroundColor Yellow
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    # Don't block startup: Grace's LLM client polls until Ollama answers, so STT/TTS/UI
    # boot in parallel and only the LLM waits for it.
    Write-Host "[Ollama] Launched -- Grace will connect once it's online." -ForegroundColor Gray
}

# --- Start Kokoro TTS server ---
Write-Host "[Kokoro] Starting TTS server..." -ForegroundColor Gray

$kokoroScript = Join-Path $graceRoot "grace_kokoro_server.py"
$logsDir = Join-Path $graceRoot "logs"

if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir | Out-Null
}

$kokoroArgs = "-3.12 `"$kokoroScript`" --port 8765 --voice af_heart"
$kokoro = Start-Process -FilePath "py" -ArgumentList $kokoroArgs -PassThru -NoNewWindow `
    -RedirectStandardOutput "$logsDir\kokoro.log" `
    -RedirectStandardError "$logsDir\kokoro-err.log"

# Start Grace immediately (Kokoro loads in the background but accepts HTTP instantly)
Write-Host "[Kokoro] Starting TTS server..." -ForegroundColor Gray
# --- Start Grace ---
Write-Host "[Grace]  Starting Electron app..." -ForegroundColor Cyan
Write-Host ""

Set-Location $graceRoot

try {
    npm run dev
} finally {
    Write-Host ""
    Write-Host "[Grace] Shutting down..." -ForegroundColor Cyan

    if ($null -ne $kokoro -and -not $kokoro.HasExited) {
        Stop-Process -Id $kokoro.Id -Force -ErrorAction SilentlyContinue
        Write-Host "[Kokoro] Stopped." -ForegroundColor Gray
    }

    Write-Host "[Grace] Done." -ForegroundColor Gray
    Write-Host ""
}
