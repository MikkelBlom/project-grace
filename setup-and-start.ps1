# setup-and-start.ps1 - Grace full setup + launcher
# Run this once to install everything and start Grace.
# Next time use: .\setup-and-start.ps1 -SkipInstall

param([switch]$SkipInstall)

$graceRoot = $PSScriptRoot
$py = "py"
$pyVer = "-3.12"

function Write-Step { param($msg) Write-Host "" ; Write-Host ">> $msg" -ForegroundColor Cyan }
function Write-OK   { param($msg) Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "   XX  $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Grace Setup + Launch" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

# -- 1. Check Python 3.12 --
Write-Step "Checking Python 3.12..."
try {
    $pyout = & $py $pyVer "--version" 2>&1
    Write-OK "$pyout"
} catch {
    Write-Fail "Python 3.12 not found."
    Write-Warn "Download from: https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe"
    Write-Warn "Check 'Add to PATH' during installation."
    exit 1
}

# -- 2. Check Node.js --
Write-Step "Checking Node.js..."
try {
    $nodeVer = node --version 2>&1
    $npmVer  = npm  --version 2>&1
    Write-OK "Node $nodeVer / npm $npmVer"
} catch {
    Write-Fail "Node.js not found."
    Write-Warn "Download from: https://nodejs.org (LTS version)"
    Write-Warn "Close and reopen PowerShell after installation, then run this script again."
    exit 1
}

# -- 3. Python packages --
if (-not $SkipInstall) {
    Write-Step "Installing Python packages..."

    Write-Host "   Downgrading transformers to 4.x (kokoro 0.9.x requires it)..." -ForegroundColor Gray
    & $py $pyVer -m pip install "transformers>=4.40,<5.0" --force-reinstall -q
    if ($LASTEXITCODE -eq 0) { Write-OK "transformers 4.x" } else { Write-Warn "transformers install failed" }

    Write-Host "   Installing kokoro + soundfile..." -ForegroundColor Gray
    & $py $pyVer -m pip install kokoro soundfile -q
    if ($LASTEXITCODE -eq 0) { Write-OK "kokoro + soundfile" } else { Write-Warn "kokoro install failed" }

    Write-Host "   Installing misaki[en] (kokoro text processing)..." -ForegroundColor Gray
    & $py $pyVer -m pip install "misaki[en]" -q
    if ($LASTEXITCODE -eq 0) { Write-OK "misaki[en]" } else { Write-Warn "misaki[en] install failed" }

    Write-Host "   Installing faster-whisper + VAD + audio..." -ForegroundColor Gray
    & $py $pyVer -m pip install faster-whisper silero-vad sounddevice -q
    if ($LASTEXITCODE -eq 0) { Write-OK "faster-whisper + silero-vad + sounddevice" } else { Write-Warn "STT install failed" }

    Write-Host "   Installing PyTorch with CUDA 12.8 (may take a while)..." -ForegroundColor Gray
    & $py $pyVer -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128 -q
    if ($LASTEXITCODE -eq 0) { Write-OK "PyTorch + CUDA" } else { Write-Warn "PyTorch install failed - Whisper will use CPU" }
}

# -- 4. Verify kokoro import --
Write-Step "Verifying kokoro..."
$kokoroTest = & $py $pyVer -c "from kokoro import KPipeline; print('OK')" 2>&1
if ($kokoroTest -match "OK") {
    Write-OK "Kokoro imports correctly"
} else {
    Write-Warn "Kokoro import failed: $kokoroTest"
    Write-Warn "TTS will fall back to Windows SAPI (works but lower quality)"
}

# -- 5. npm install --
Write-Step "Installing Node.js dependencies..."
$nodeModules = Join-Path $graceRoot "node_modules"
if (-not $SkipInstall -or -not (Test-Path $nodeModules)) {
    Push-Location $graceRoot
    npm install --silent
    if ($LASTEXITCODE -eq 0) { Write-OK "npm install done" }
    else { Write-Fail "npm install failed"; Pop-Location; exit 1 }
    Pop-Location
} else {
    Write-OK "node_modules already present"
}

# -- 6. Check Ollama --
Write-Step "Checking Ollama..."
try {
    $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 3
    $models = $tags.models | ForEach-Object { $_.name }
    Write-OK "Ollama running. Models: $($models -join ', ')"
    if (-not ($models -match "gemma4")) {
        Write-Warn "gemma4 not pulled yet. Run in another terminal: ollama pull gemma4:26b"
    }
} catch {
    Write-Warn "Ollama not responding on 127.0.0.1:11434"
    Write-Warn "Make sure Ollama is installed and running (check tray icon)"
    Write-Warn "Install: winget install Ollama.Ollama"
}

# -- 7. Set env vars --
Write-Step "Setting environment variables..."
$env:GRACE_LLM_PROVIDER  = "ollama"
$env:GRACE_STT_PROVIDER  = "whisper"
$env:GRACE_TTS_PROVIDER  = "kokoro"
$env:GRACE_LLM_MODEL     = "gemma4:26b"
$env:GRACE_WHISPER_MODEL = "large-v3"
$env:GRACE_WHISPER_LANG  = "da"
$env:GRACE_PYTHON_CMD    = "py"
$env:GRACE_PYTHON_VER    = "-3.12"
Write-OK "Environment variables set"

# -- 8. Start Kokoro TTS server --
Write-Step "Starting Kokoro TTS server..."
$kokoroScript = Join-Path $graceRoot "grace_kokoro_server.py"
$logsDir = Join-Path $graceRoot "logs"
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }

$kokoroArgs = "$pyVer `"$kokoroScript`" --port 8765 --voice da_DK-talesyntese-medium"
$kokoro = Start-Process -FilePath $py -ArgumentList $kokoroArgs -PassThru -NoNewWindow `
    -RedirectStandardOutput "$logsDir\kokoro.log" `
    -RedirectStandardError  "$logsDir\kokoro-err.log"

$kokoroReady = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod -Uri "http://localhost:8765/health" -TimeoutSec 1
        Write-OK "Kokoro ready - engine: $($health.engine), voice: $($health.voice)"
        $kokoroReady = $true
        break
    } catch { }
}

if (-not $kokoroReady) {
    Write-Warn "Kokoro did not respond - see logs\kokoro-err.log"
    Write-Warn "Grace will use Windows SAPI as fallback"
    if (Test-Path "$logsDir\kokoro-err.log") {
        $errLog = Get-Content "$logsDir\kokoro-err.log" -Tail 5
        if ($errLog) {
            Write-Host "   Last lines from kokoro-err.log:" -ForegroundColor DarkGray
            $errLog | ForEach-Object { Write-Host "   $_" -ForegroundColor DarkGray }
        }
    }
}

# -- 9. Start Grace --
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Starting Grace..." -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $graceRoot

try {
    npm run dev
} finally {
    Write-Host ""
    Write-Host "Grace closed. Cleaning up..." -ForegroundColor Cyan
    if ($null -ne $kokoro -and -not $kokoro.HasExited) {
        Stop-Process -Id $kokoro.Id -Force -ErrorAction SilentlyContinue
        Write-Host "Kokoro stopped." -ForegroundColor Gray
    }
    Write-Host "Done." -ForegroundColor Gray
}
