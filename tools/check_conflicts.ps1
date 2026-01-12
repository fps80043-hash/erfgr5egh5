$ErrorActionPreference="Stop"
Write-Host "Checking for git conflict markers (<<<<<<< ======= >>>>>>>)..." -ForegroundColor Cyan
$bad = git grep -n "<<<<<<<" -- . 2>$null
if($bad){
  Write-Host "FOUND conflict markers:" -ForegroundColor Red
  Write-Host $bad
  exit 1
}
Write-Host "OK: no conflict markers found." -ForegroundColor Green
