param([string]$InputPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'calibrations/temperature-brightness-calibration.json'))
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/NativeControl.ps1"
$calibration = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($calibration.DisplayId) -or @($calibration.Points).Count -lt 4) { throw '校准结果不完整。' }


$snapshot = Send-Go @{Action='snapshot'}
if ($null -eq $snapshot.Settings.TemperatureBrightnessCalibrations) { throw '请先启动支持内屏补光的新版核心。' }
$display = @($snapshot.Displays | Where-Object Id -eq $calibration.DisplayId)
if ($display.Count -ne 1 -or -not $display[0].CanAdjustColor) { throw '校准对应的内屏未连接或不支持调色。' }
$matchingPanel = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness | Where-Object {
    $_.Active -and ($_.InstanceName.Equals($calibration.DisplayId, [StringComparison]::OrdinalIgnoreCase) -or
        $_.InstanceName.StartsWith($calibration.DisplayId + '_', [StringComparison]::OrdinalIgnoreCase))
})
if ($matchingPanel.Count -ne 1) { throw '校准设备未匹配到唯一内屏，未修改设置。' }
$snapshot.Settings.TemperatureBrightnessCalibrations | Add-Member -NotePropertyName $calibration.DisplayId -NotePropertyValue ([pscustomobject]@{Points=@($calibration.Points)}) -Force
# The core validates the samples and the latest Revision before persisting this single-device change.
$saved = Send-Go @{Action='save';Settings=$snapshot.Settings}
if ($null -eq $saved.Settings.TemperatureBrightnessCalibrations.PSObject.Properties[$calibration.DisplayId]) { throw '核心没有保存校准结果。' }
Write-Output ('Saved calibration for ' + $calibration.DisplayId)
$saved.Displays | Select-Object Name, Brightness, Kelvin, BacklightTarget, Error | Format-Table -AutoSize
if ($saved.Warning) { Write-Output $saved.Warning }
