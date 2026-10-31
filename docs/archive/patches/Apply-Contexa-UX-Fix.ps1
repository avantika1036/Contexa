$ErrorActionPreference = "Stop"

$root = (Get-Location).Path
$appFile = Join-Path $root "frontend\src\App.tsx"
$cssFile = Join-Path $root "frontend\src\App.css"

if (!(Test-Path $appFile)) { throw "Run this script from the Contexa repository root. Missing frontend\src\App.tsx." }
if (!(Test-Path $cssFile)) { throw "Missing frontend\src\App.css." }

$app = [System.IO.File]::ReadAllText($appFile)
$changed = $false

# Let the native details element manage its own open/closed state.
$detailsWithForcedClosed = '<details className="manual-capture-details" open={false}>'
$detailsNormal = '<details className="manual-capture-details">'
if ($app.Contains($detailsWithForcedClosed)) {
    $app = $app.Replace($detailsWithForcedClosed, $detailsNormal)
    $changed = $true
} elseif (!$app.Contains($detailsNormal)) {
    throw "Could not locate Advanced audio diagnostics details markup. No further changes made."
}

# Restore the helpful, compact subtitle within the existing panel heading.
$heading = '<div className="copilot-title"><h2>Meeting context</h2></div>'
$headingWithSubtitle = '<div className="copilot-title"><h2>Meeting context</h2><p className="copilot-subtitle">Live transcript &amp; structured memory</p></div>'
if (!$app.Contains('className="copilot-subtitle"')) {
    if (!$app.Contains($heading)) {
        throw "Could not locate Meeting context heading. No further changes made."
    }
    $app = $app.Replace($heading, $headingWithSubtitle)
    $changed = $true
}

if ($changed) {
    [System.IO.File]::WriteAllText($appFile, $app, [System.Text.UTF8Encoding]::new($false))
}

$marker = "/* Contexa focused workspace fixes v1 */"
$css = [System.IO.File]::ReadAllText($cssFile)
if (!$css.Contains($marker)) {
$override = @'

/* Contexa focused workspace fixes v1 */
:root {
  --accent-violet: #7167e8;
  --accent-violet-soft: #f3f1ff;
  --accent-teal: #259c91;
  --accent-teal-soft: #edf9f6;
  --accent-blue: #5688cf;
  --accent-blue-soft: #eff6ff;
  --accent-amber: #c18a35;
  --accent-amber-soft: #fff7e9;
}

/* Keep the copilot as one persistent panel: only its content scrolls/changes. */
html, body, #root {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.app-shell {
  width: 100%;
  height: 100dvh;
  min-height: 560px;
  overflow: hidden;
}
.main-area {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}
.workspace {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  overflow: hidden;
  grid-template-columns: minmax(0, .96fr) minmax(0, 1.04fr);
  align-items: stretch;
}
.meeting-column {
  height: 100%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
.copilot-panel {
  display: flex;
  flex-direction: column;
  align-self: stretch;
  position: relative;
  top: auto;
  height: 100%;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
}
.copilot-heading {
  flex: 0 0 auto;
  position: relative;
  z-index: 2;
  background: #fff;
}
.copilot-title {
  min-width: 0;
}
.copilot-subtitle {
  margin: 3px 0 0;
  color: #8b96a9;
  font-size: 11.5px;
  line-height: 1.35;
}
.copilot-tabs {
  flex: 0 0 auto;
  min-height: 42px;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  position: relative;
  z-index: 2;
  background: #fff;
  scrollbar-width: thin;
}
.copilot-tabs button {
  flex: 0 0 auto;
  line-height: 1.25;
}
.copilot-content {
  flex: 1 1 0%;
  height: auto;
  min-height: 0;
  max-height: none;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  position: relative;
}
.tab-content {
  min-height: 100%;
}

/* Main workspace stays chic: color lives in icon tiles, not card edges. */
.overview-metric::before {
  content: none !important;
  display: none !important;
}
.overview-metric,
.overview-metric:nth-child(n),
.overview-highlights-card,
.overview-list-card,
.overview-card-wide,
.overview-open-questions,
.overview-list-card:nth-child(n) {
  background: #fff;
  border-color: #e5e9f1;
}
.overview-card {
  box-shadow: 0 2px 8px rgba(37, 44, 78, .025);
}
.metric-icon-duration { color: #6b5ce7; background: #f0edff; }
.metric-icon-transcript { color: #1788a5; background: #e8f7fb; }
.metric-icon-memory { color: #b77918; background: #fff4df; }

/* Keep transcript speaker labels consistent; avoid rainbow speaker IDs. */
.transcript-speaker,
.transcript-segment:nth-of-type(4n + 1) .transcript-speaker,
.transcript-segment:nth-of-type(4n + 2) .transcript-speaker,
.transcript-segment:nth-of-type(4n + 3) .transcript-speaker,
.transcript-segment:nth-of-type(4n + 4) .transcript-speaker {
  color: #5b50d7 !important;
}

/* Details can expand naturally; the meeting column owns vertical scrolling. */
.manual-capture-details {
  flex: 0 0 auto;
  overflow: visible;
  max-height: none;
}
.manual-capture-details > summary {
  user-select: none;
}
.manual-capture-details[open] {
  background: #fff;
}
.manual-capture-details[open] > summary {
  position: relative;
  background: #fff;
}
.manual-capture-details .meeting-actions {
  display: block;
}

@media (max-width: 1080px) {
  html, body, #root { height: auto; min-height: 100%; overflow: auto; }
  .app-shell { height: auto; min-height: 100dvh; overflow: visible; }
  .main-area { height: auto; min-height: 100dvh; overflow: visible; }
  .workspace { height: auto; min-height: 0; overflow: visible; grid-template-columns: minmax(0, 1fr); }
  .meeting-column { height: auto; max-height: none; overflow: visible; }
  .copilot-panel { height: 680px; min-height: 560px; max-height: none; }
  .copilot-content { flex: 1 1 auto; height: auto; min-height: 0; max-height: none; }
}
'@
    $css += "`r`n" + $override + "`r`n"
    [System.IO.File]::WriteAllText($cssFile, $css, [System.Text.UTF8Encoding]::new($false))
}

Write-Host "Applied the Contexa tab, scroll and diagnostics fix."
Write-Host "No backend, .env, database or migration files were changed."
