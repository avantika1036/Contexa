$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envFile = Join-Path $root '.env'
$exampleEnv = Join-Path $root '.env.example'
$backendDir = Join-Path $root 'backend'
$frontendDir = Join-Path $root 'frontend'
$desktopDir = $PSScriptRoot

if (-not (Test-Path $envFile)) {
    if (Test-Path $exampleEnv) {
        Copy-Item -LiteralPath $exampleEnv -Destination $envFile
        Write-Warning 'Created .env from .env.example. Add DATABASE_URL credentials and API keys to .env, then run this script again.'
        exit 1
    }
    throw 'Repository-root .env is missing. Create it using the project README before continuing.'
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Python was not found on PATH. Install Python 3.11+ first.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Node.js/npm was not found on PATH. Install current Node.js LTS first.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop / Docker Compose is required for the local PostgreSQL database.' }

$pythonExe = Join-Path $backendDir '.venv\Scripts\python.exe'
if (-not (Test-Path $pythonExe)) {
    Write-Host 'Creating the backend virtual environment…' -ForegroundColor Cyan
    & python -m venv (Join-Path $backendDir '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create backend/.venv.' }
    & $pythonExe -m pip install --upgrade pip
    & $pythonExe -m pip install -r (Join-Path $backendDir 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Backend dependency installation failed.' }
}

if (-not (Test-Path (Join-Path $frontendDir 'node_modules\vite'))) {
    Write-Host 'Installing frontend dependencies…' -ForegroundColor Cyan
    Push-Location $frontendDir
    try { & npm ci; if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' } }
    finally { Pop-Location }
}

Write-Host 'Building the Contexa desktop interface…' -ForegroundColor Cyan
Push-Location $frontendDir
try { & npm run build; if ($LASTEXITCODE -ne 0) { throw 'Frontend production build failed.' } }
finally { Pop-Location }

$electronPackageDir = Join-Path $desktopDir 'node_modules\electron'
$electronBinary = Join-Path $electronPackageDir 'dist\electron.exe'

if (-not (Test-Path $electronPackageDir)) {
    Write-Host 'Installing Contexa Desktop dependencies…' -ForegroundColor Cyan
    Push-Location $desktopDir
    try { & npm install; if ($LASTEXITCODE -ne 0) { throw 'Desktop dependency installation failed.' } }
    finally { Pop-Location }
}

# npm 11/12 may block dependency install scripts unless explicitly approved.
# Electron's install script downloads the native electron.exe. npm can finish
# installing the JS package without that binary, which makes `npm start` fail.
if (-not (Test-Path $electronBinary)) {
    Write-Host 'Electron is installed but its Windows binary is missing. Approving only Electron and repairing its install…' -ForegroundColor Yellow
    Push-Location $desktopDir
    try {
        & npm install-scripts approve electron
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not approve Electron install script. Run: npm install-scripts approve electron'
        }

        & npm rebuild electron
        if ($LASTEXITCODE -ne 0) {
            throw 'Electron repair failed. Check network access to Electron releases, then rerun this setup script.'
        }
    }
    finally { Pop-Location }
}

if (-not (Test-Path $electronBinary)) {
    throw "Electron's native binary is still missing at '$electronBinary'. The repair did not complete; check network/proxy/antivirus restrictions and rerun this script."
}

# Create a normal Windows desktop shortcut for future launches. The shortcut starts
# the VBS launcher silently; the actual Contexa UI is still a native Electron window.
try {
    $desktopPath = [Environment]::GetFolderPath('Desktop')
    $vbsLauncher = Join-Path $root 'Open-Contexa.vbs'
    if ((Test-Path -LiteralPath $desktopPath) -and (Test-Path -LiteralPath $vbsLauncher)) {
        $shortcutPath = Join-Path $desktopPath 'Contexa.lnk'
        $wscriptPath = Join-Path $env:WINDIR 'System32\wscript.exe'
        $wsh = New-Object -ComObject WScript.Shell
        $shortcut = $wsh.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $wscriptPath
        $shortcut.Arguments = '"' + $vbsLauncher + '"'
        $shortcut.WorkingDirectory = $root
        $iconFile = Join-Path $desktopDir 'assets\contexa.ico'
        if (Test-Path -LiteralPath $iconFile) { $shortcut.IconLocation = "$iconFile,0" }
        $shortcut.Description = 'Open Contexa Desktop meeting intelligence'
        $shortcut.Save()
        Write-Host "Created desktop shortcut: $shortcutPath" -ForegroundColor Cyan
    }
} catch {
    Write-Warning "Could not create a desktop shortcut automatically: $($_.Exception.Message)"
}

Write-Host 'Starting Contexa Desktop. The React interface opens inside the app window; approve the first-run consent dialog to enable hands-free meeting detection.' -ForegroundColor Green
Push-Location $desktopDir
try { & npm start; if ($LASTEXITCODE -ne 0) { throw 'Contexa Desktop exited with an error.' } }
finally { Pop-Location }
