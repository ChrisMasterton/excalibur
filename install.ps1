#requires -Version 5.1

# Excalibur Windows install script.

[CmdletBinding()]
param(
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "[SUCCESS] $Message" -ForegroundColor Green
}

function Fail {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
}

function Require-Command {
    param(
        [string]$Name,
        [string]$InstallHint
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Fail "$Name is not installed. $InstallHint"
    }
}

function Assert-LastExitCode {
    param([string]$Message)

    if ($LASTEXITCODE -ne 0) {
        Fail $Message
    }
}

function Get-LatestFile {
    param(
        [string]$Directory,
        [string]$Filter
    )

    if (-not (Test-Path $Directory)) {
        return $null
    }

    Get-ChildItem -Path $Directory -Filter $Filter -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

function Find-WindowsInstaller {
    $bundleRoot = Join-Path $ScriptRoot "src-tauri\target\release\bundle"
    $nsisInstaller = Get-LatestFile -Directory (Join-Path $bundleRoot "nsis") -Filter "*.exe"
    if ($nsisInstaller) {
        return $nsisInstaller
    }

    $msiInstaller = Get-LatestFile -Directory (Join-Path $bundleRoot "msi") -Filter "*.msi"
    if ($msiInstaller) {
        return $msiInstaller
    }

    return $null
}

function Install-ReleaseExecutable {
    $releaseExe = Join-Path $ScriptRoot "src-tauri\target\release\excalibur-tauri.exe"
    if (-not (Test-Path $releaseExe)) {
        Fail "No Windows installer or release executable was found."
    }

    $installDir = Join-Path $env:LOCALAPPDATA "Programs\Excalibur"
    $installedExe = Join-Path $installDir "Excalibur.exe"

    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    Copy-Item -Path $releaseExe -Destination $installedExe -Force

    Write-Success "Installed Excalibur to $installedExe"
    Write-Info "Launch it with: .\run.ps1"
}

function Run-Installer {
    param([System.IO.FileInfo]$Installer)

    Write-Info "Running installer: $($Installer.FullName)"

    if ($Installer.Extension -ieq ".msi") {
        $args = @("/i", "`"$($Installer.FullName)`"")
        $process = Start-Process -FilePath "msiexec.exe" -ArgumentList $args -Wait -PassThru
    } else {
        $process = Start-Process -FilePath $Installer.FullName -Wait -PassThru
    }

    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
        Fail "Installer exited with code $($process.ExitCode)."
    }

    Write-Success "Installer completed."
}

Set-Location $ScriptRoot

Write-Host ""
Write-Host "Excalibur Windows Install"
Write-Host ""

Write-Info "Checking prerequisites..."
Require-Command -Name "node" -InstallHint "Install Node.js 18+ from https://nodejs.org/"
Require-Command -Name "npm.cmd" -InstallHint "Install npm with Node.js."
Require-Command -Name "rustc" -InstallHint "Install Rust from https://rustup.rs/"
Require-Command -Name "cargo" -InstallHint "Install Rust from https://rustup.rs/"

$nodeVersion = (& node --version).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 18) {
    Fail "Node.js 18+ is required. Current version: $nodeVersion"
}
Write-Success "Node.js $nodeVersion found"
Write-Success "npm $((& npm.cmd --version).Trim()) found"
Write-Success "Rust $((& rustc --version).Trim()) found"

& cargo tauri --version | Out-Null
Assert-LastExitCode "Tauri CLI is not installed. Run: cargo install tauri-cli --locked"
Write-Success "Tauri CLI found"

Write-Info "Installing frontend dependencies..."
Push-Location (Join-Path $ScriptRoot "frontend")
& npm.cmd install
Assert-LastExitCode "npm install failed."
Pop-Location
Write-Success "Frontend dependencies installed"

Write-Info "Building Excalibur..."
& cargo tauri build
Assert-LastExitCode "cargo tauri build failed."
Write-Success "Build complete"

$installer = Find-WindowsInstaller
if ($SkipInstall) {
    if ($installer) {
        Write-Success "Windows installer created at $($installer.FullName)"
    } else {
        $releaseExe = Join-Path $ScriptRoot "src-tauri\target\release\excalibur-tauri.exe"
        if (-not (Test-Path $releaseExe)) {
            Fail "No Windows installer or release executable was found."
        }
        Write-Success "Windows executable created at $releaseExe"
    }
    exit 0
}

if ($installer) {
    Run-Installer -Installer $installer
} else {
    Install-ReleaseExecutable
}
