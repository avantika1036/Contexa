# Moves old patch notes/scripts out of the repository root into docs/archive/patches.
# Nothing is deleted. Safe to run more than once.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$archive = Join-Path $root 'docs\archive\patches'
New-Item -ItemType Directory -Force -Path $archive | Out-Null

$legacy = @(
    'CHAT_QA_PATCH.md', 'MEETING_OVERVIEW_PATCH.md', 'FRONTEND_REFINEMENTS.md',
    'UI-REFRESH-NOTES.md', 'PATCH_INSTALL.md',
    'Apply-Contexa-UI-Refresh.ps1', 'Apply-Contexa-UX-Fix.ps1'
)
foreach ($name in $legacy) {
    $source = Join-Path $root $name
    if (Test-Path -LiteralPath $source) {
        Move-Item -LiteralPath $source -Destination (Join-Path $archive $name) -Force
        Write-Host "Archived $name" -ForegroundColor Green
    }
}
Write-Host "Legacy patch files are in docs\archive\patches." -ForegroundColor Cyan
