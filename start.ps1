# Grace launcher -- sets UTF-8 console encoding before starting npm
# Run this instead of `npm run dev` to get clean Danish characters in the console.
#
# Usage: .\start.ps1
#        .\start.ps1 -Prod    (skips tsc watch, faster restart)

param([switch]$Prod)

# UTF-8 everywhere
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
$env:PYTHONUTF8           = '1'
$env:PYTHONIOENCODING     = 'utf-8'
chcp 65001 | Out-Null

Write-Host "[Grace] Console sat til UTF-8 (CP65001)" -ForegroundColor Cyan

npm run dev
