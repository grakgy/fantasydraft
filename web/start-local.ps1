$ErrorActionPreference = "Stop"

$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (Test-Path -LiteralPath $bundledNode) {
    $nodeExecutable = $bundledNode
} else {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        throw "Node.js was not found. Install Node.js 20 or newer."
    }
    $majorVersion = [int]((& $nodeCommand.Source --version).TrimStart("v").Split(".")[0])
    if ($majorVersion -lt 20) {
        throw "Node.js 20 or newer is required."
    }
    $nodeExecutable = $nodeCommand.Source
}

Set-Location -LiteralPath $PSScriptRoot
$enginePackage = Join-Path $PSScriptRoot "node_modules\footballsim\package.json"
if (-not (Test-Path -LiteralPath $enginePackage)) {
    Write-Host "Installing the local match-engine dependency (first run only)..." -ForegroundColor Yellow
    $bundledPnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
    if (Test-Path -LiteralPath $bundledPnpm) {
        & $bundledPnpm install --frozen-lockfile
    } else {
        $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
        if (-not $npmCommand) {
            throw "The footballsim dependency is missing. Run npm install once, then start again."
        }
        & $npmCommand.Source install
    }
}
$localPort = if ($env:PORT) { $env:PORT } else { "3000" }
Write-Host "FM26 Fantasy Draft: http://127.0.0.1:$localPort" -ForegroundColor Green
Write-Host "Press Ctrl+C in this window to stop the server." -ForegroundColor DarkGray
& $nodeExecutable "server.mjs"
