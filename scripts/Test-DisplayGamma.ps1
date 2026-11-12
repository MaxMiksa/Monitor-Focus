param(
    [switch]$Apply,
    [switch]$Interactive,
    [ValidateRange(1, 15)][int]$HoldSeconds = 6,
    [ValidateRange(2700, 6500)][int]$Kelvin = 3500,
    [string]$DisplayName,
    [string]$Dotnet = 'dotnet'
)
$ErrorActionPreference = 'Stop'
$probeProject = Join-Path (Split-Path $PSScriptRoot -Parent) 'tests/MonitorsFocus.Tests/MonitorsFocus.Tests.csproj'
$probeArguments = @('--gamma-probe', '--hold', "$HoldSeconds", '--kelvin', "$Kelvin")
if ($Apply) { $probeArguments += '--apply' }
if ($Interactive) { $probeArguments += @('--apply', '--interactive') }
if ($DisplayName) { $probeArguments += @('--display', $DisplayName) }
# Run the same color adapter as the core. Build the Release tests before invoking this diagnostic.
& $Dotnet run --project $probeProject -c Release --no-build -- @probeArguments
if ($LASTEXITCODE) { throw 'Display gamma probe failed. See the restore results above.' }
