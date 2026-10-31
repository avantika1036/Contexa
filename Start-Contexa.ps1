$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $root 'desktop\setup-and-run.ps1'
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Contexa Desktop launcher was not found at '$launcher'."
}
& $launcher
