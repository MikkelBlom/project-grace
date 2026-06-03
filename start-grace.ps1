# start-grace.ps1 - Grace Phase 1 launcher
# Starter Kokoro TTS i baggrunden og launcher Grace.
# Rydder automatisk op naar Grace lukkes.

$graceRoot = $PSScriptRoot

# --- Konfiguration ---
$env:GRACE_LLM_PROVIDER  = "ollama"
$env:GRACE_STT_PROVIDER  = "whisper"
$env:GRACE_TTS_PROVIDER  = "kokoro"
$env:GRACE_LLM_MODEL     = "gemma4:26b"
$env:GRACE_WHISPER_MODEL = "large-v3"
$env:GRACE_WHISPER_LANG  = "da"
$env:GRACE_PYTHON_CMD    = "py"

# --- Mikrofon-valg ---------------------------------------------------------
# GRACE_MIC_NAME = del af enhedsnavnet (case-insensitivt). Tom "" = Windows default.
# !! BLUETOOTH: bruger man Buds4 som MIKROFON, tvinger Windows dem i "headset"-tilstand
#    (HFP) = MONO, kun den ene oeretelefon, lav kvalitet. Stereo (A2DP) kommer foerst
#    tilbage naar mikrofonen slippes (derfor spiller YouTube fint bagefter).
#   "Realtek" = laptop-mik -> Buds4 forbliver STEREO til output  (anbefalet hvis mono generer)
#   "Buds4"   = bedste mik-praecision, MEN mono-output i begge oerer (BT-begraensning)
#   "VF0700"  = webcam-mik (daarligst)
$env:GRACE_MIC_NAME      = "Buds4"

Write-Host ""
Write-Host "[Grace] Starting up..." -ForegroundColor Cyan

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

# Wait for Kokoro to be ready (max 10 seconds)
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod -Uri "http://localhost:8765/health" -TimeoutSec 1
        Write-Host "[Kokoro] Ready - engine: $($health.engine), voice: $($health.voice)" -ForegroundColor Green
        $ready = $true
        break
    } catch {
        # Not ready yet
    }
}

if (-not $ready) {
    Write-Host "[Kokoro] Did not respond - falling back to Windows SAPI" -ForegroundColor Yellow
}

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
