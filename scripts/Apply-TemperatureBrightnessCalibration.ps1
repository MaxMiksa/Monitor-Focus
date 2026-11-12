param([string]$InputPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'publish/temperature-brightness-calibration.json'))
$ErrorActionPreference = 'Stop'
$calibration = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($calibration.DisplayId) -or @($calibration.Points).Count -lt 4) { throw '校准结果不完整。' }

function Send-CalibrationSettingsRequest([object]$Request) {
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', ('MonitorsFocus.ControlCenter.' + [Environment]::UserName), 'InOut')
    try {
        $pipe.Connect(3000)
        $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false), 1024, $true)
        $writer.AutoFlush = $true
        $writer.WriteLine(($Request | ConvertTo-Json -Depth 32 -Compress))
        $reader = [System.IO.StreamReader]::new($pipe, [System.Text.Encoding]::UTF8, $false, 1024, $true)
        $reply = $reader.ReadLineAsync()
        if (-not $reply.Wait(5000)) { throw '控制核心未及时回应。' }
        $response = $reply.Result | ConvertFrom-Json
        if ($response.Error) { throw $response.Error }
        return $response
    } finally { $pipe.Dispose() }
}

$snapshot = Send-CalibrationSettingsRequest @{Action='snapshot'}
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
$saved = Send-CalibrationSettingsRequest @{Action='save';Settings=$snapshot.Settings}
if ($null -eq $saved.Settings.TemperatureBrightnessCalibrations.PSObject.Properties[$calibration.DisplayId]) { throw '核心没有保存校准结果。' }
Write-Output ('Saved calibration for ' + $calibration.DisplayId)
$saved.Displays | Select-Object Name, Brightness, Kelvin, BacklightTarget, Error | Format-Table -AutoSize
if ($saved.Warning) { Write-Output $saved.Warning }
