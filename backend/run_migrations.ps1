$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Current Alembic revision:" -ForegroundColor Cyan
python -m alembic current
if ($LASTEXITCODE -ne 0) { throw "Could not read the current database revision. Check DATABASE_URL and PostgreSQL." }

Write-Host "Applying pending Contexa migrations..." -ForegroundColor Cyan
python -m alembic upgrade head
if ($LASTEXITCODE -ne 0) { throw "Alembic upgrade failed. Keep the database volume; share the error output before retrying." }

Write-Host "Final Alembic revision:" -ForegroundColor Cyan
python -m alembic current
if ($LASTEXITCODE -ne 0) { throw "Could not verify the final database revision." }
Write-Host "Migrations finished. Existing meeting and transcript data was not reset." -ForegroundColor Green
