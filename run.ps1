# Launch an installed or locally built Windows Excalibur executable.

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

$candidates = @()

if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA "Programs\Excalibur\Excalibur.exe"
}

$programFiles = [Environment]::GetFolderPath("ProgramFiles")
if ($programFiles) {
    $candidates += Join-Path $programFiles "Excalibur\Excalibur.exe"
}

$programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
if ($programFilesX86) {
    $candidates += Join-Path $programFilesX86 "Excalibur\Excalibur.exe"
}

$candidates += Join-Path $ScriptRoot "src-tauri\target\release\excalibur-tauri.exe"

foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
        Start-Process -FilePath $candidate
        Write-Host "Launched $candidate"
        exit 0
    }
}

Write-Host "No installed or built Excalibur executable was found." -ForegroundColor Red
Write-Host "Run .\install.ps1 or cargo tauri build first."
exit 1
