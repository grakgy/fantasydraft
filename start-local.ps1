$ErrorActionPreference = "Stop"

$webLauncher = Join-Path $PSScriptRoot "web\start-local.ps1"
if (-not (Test-Path -LiteralPath $webLauncher)) {
    throw "Local launcher was not found: $webLauncher"
}

& $webLauncher
exit $LASTEXITCODE
