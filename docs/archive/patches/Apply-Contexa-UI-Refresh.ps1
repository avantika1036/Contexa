$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$frontendDir = Join-Path $projectRoot "frontend"

if (!(Test-Path (Join-Path $frontendDir "package.json"))) {
    throw "Could not find frontend\package.json. Extract this patch into the root of C:\Work\Contexa."
}

Push-Location $frontendDir
try {
    $viteCommand = Join-Path $frontendDir "node_modules\.bin\vite.cmd"
    $tscCommand = Join-Path $frontendDir "node_modules\.bin\tsc.cmd"

    if (!(Test-Path $viteCommand) -or !(Test-Path $tscCommand)) {
        Write-Host "Frontend dependencies are missing. Installing locked dependencies..."
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed. Review the npm output above."
        }
    }

    Write-Host "Building the refreshed Contexa interface..."
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend build failed. Contexa source files were updated, but the existing build was not confirmed."
    }

    if (!(Test-Path (Join-Path $frontendDir "dist\index.html"))) {
        throw "Build command finished, but frontend\dist\index.html was not found."
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Contexa UI refresh built successfully." -ForegroundColor Green
Write-Host "Now close Contexa completely, including its system-tray icon, and reopen it."
Write-Host "This script does not modify your .env, database, migrations, or Git history."
