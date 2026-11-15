$ErrorActionPreference='Stop'
$packagesRoot=Join-Path (Split-Path $PSScriptRoot -Parent) 'build/packages'
if(-not (Test-Path -LiteralPath $packagesRoot)){return}
$packagesRoot=(Resolve-Path -LiteralPath $packagesRoot).Path
$packages=@(Get-ChildItem -LiteralPath $packagesRoot -Directory | Where-Object Name -Match '^\d{8}-\d{6}-\d{3}$' | Sort-Object Name -Descending)
$obsolete=@($packages | Select-Object -Skip 5)
$activePaths=@(Get-CimInstance Win32_Process -Filter "Name='MonitorsFocus.Go.exe'" | ForEach-Object ExecutablePath)
$startupKey=Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Run'
$startupCommand=[string]$startupKey.MonitorsFocus
# Validate the entire deletion set before recycling anything.
foreach($package in $obsolete){
    $target=(Resolve-Path -LiteralPath $package.FullName).Path
    if(-not $target.StartsWith($packagesRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or ($package.Attributes -band [IO.FileAttributes]::ReparsePoint)){
        throw "Refused out-of-scope or linked package: $target"
    }
    if(@($activePaths | Where-Object { $_ -and $_.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase) }).Count -or $startupCommand.IndexOf($target,[StringComparison]::OrdinalIgnoreCase) -ge 0){
        throw "Older package is still running or referenced by startup: $target"
    }
}
Add-Type -AssemblyName Microsoft.VisualBasic
foreach($package in $obsolete){
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($package.FullName,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
}
[pscustomobject]@{Kept=@($packages | Select-Object -First 5 | ForEach-Object Name);Recycled=@($obsolete | ForEach-Object Name)}
