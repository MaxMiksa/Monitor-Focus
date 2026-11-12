param([string]$Dotnet = 'dotnet', [switch]$Package, [string]$Pnpm = 'pnpm')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
    if (-not (Get-Command $Dotnet -ErrorAction SilentlyContinue)) { throw '.NET 10 SDK not found. Pass -Dotnet with its executable path.' }
    if (-not (Get-Command $Pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm 12.16.1 not found. Pass -Pnpm with its executable path.' }
    $pnpmVersion = & $Pnpm --version
    if ($LASTEXITCODE -or $pnpmVersion.Trim() -ne '12.16.1') { throw 'pnpm 12.16.1 is required. Pass -Pnpm with its executable path.' }
    & $Pnpm --dir src/MonitorsFocus.Web install --frozen-lockfile
    if ($LASTEXITCODE) { throw 'Frontend dependency restore failed.' }
    & $Pnpm --dir src/MonitorsFocus.Web run build
    if ($LASTEXITCODE) { throw 'Frontend build failed.' }
    & $Dotnet build MonitorsFocus.sln -c Release --nologo
    if ($LASTEXITCODE) { throw 'Desktop build failed.' }
    if ($Package) {
        $output = Join-Path $projectRoot ('publish/control-center-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        & $Dotnet publish src/MonitorsFocus/MonitorsFocus.csproj -c Release -r win-x64 --self-contained true -o (Join-Path $output 'core')
        if ($LASTEXITCODE) { throw 'Core publish failed.' }
        & $Dotnet publish src/MonitorsFocus.WebHost/MonitorsFocus.WebHost.csproj -c Release -r win-x64 --self-contained true -o (Join-Path $output 'desktop')
        if ($LASTEXITCODE) { throw 'Desktop publish failed.' }
        Write-Host "Package: $output\desktop\MonitorsFocus.WebHost.exe"
    }
} finally { Pop-Location }
