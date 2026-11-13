param(
    [string]$InputPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'calibrations/aoc-boe-brightness.json'),
    [switch]$EnableLink
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/NativeControl.ps1"
$calibration = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
if (-not $calibration.SourceId -or -not $calibration.TargetId -or @($calibration.Points).Count -lt 2) { throw '校准结果不完整。' }


$snapshot = Send-Go @{Action='snapshot'}
if ($null -eq $snapshot.Settings.PSObject.Properties['BrightnessLinkCalibration']) { throw '请先启动支持校准联动的新版核心。' }
foreach ($id in @($calibration.SourceId, $calibration.TargetId)) {
    if (@($snapshot.Displays | Where-Object { $_.Id -eq $id -and $_.CanAdjust }).Count -ne 1) {
        throw '校准对应的两块屏幕必须已连接且可调亮度，未修改设置。'
    }
}
$snapshot.Settings.BrightnessLinkCalibration = $calibration
if ($EnableLink) {
    $snapshot.Settings.Linked = $true
    foreach ($display in $snapshot.Displays | Where-Object CanAdjust) {
        $snapshot.Settings.LinkWeights | Add-Member -NotePropertyName $display.Id -NotePropertyValue ([Math]::Max(1, $display.Brightness)) -Force
    }
}
# A fresh Revision and core-side validation protect against concurrent edits and malformed samples.
$saved = Send-Go @{Action='save';Settings=$snapshot.Settings}
if ($saved.Settings.BrightnessLinkCalibration.SourceId -ne $calibration.SourceId -or
    $saved.Settings.BrightnessLinkCalibration.TargetId -ne $calibration.TargetId) { throw '核心没有保存校准结果。' }
$saved.Displays | Select-Object Name, Brightness, Kelvin, BacklightTarget, Error | Format-Table -AutoSize
if ($saved.Warning) { Write-Output $saved.Warning }
