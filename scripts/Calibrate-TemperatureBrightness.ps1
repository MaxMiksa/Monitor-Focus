param([string]$OutputPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'publish/temperature-brightness-calibration.json'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Send-CalibrationCommand {
    param([string]$Action, [Nullable[int]]$Value = $null, [string]$Id = $null, [object]$Settings = $null)
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', ('MonitorsFocus.ControlCenter.' + [Environment]::UserName), 'InOut')
    try {
        $pipe.Connect(3000)
        $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false), 1024, $true)
        $writer.AutoFlush = $true
        $writer.WriteLine((@{Action=$Action;Value=$Value;Id=$Id;Settings=$Settings} | ConvertTo-Json -Depth 32 -Compress))
        $reader = [System.IO.StreamReader]::new($pipe, [System.Text.Encoding]::UTF8, $false, 1024, $true)
        $reply = $reader.ReadLineAsync()
        if (-not $reply.Wait(5000)) { throw '控制核心未及时回应。' }
        $response = $reply.Result | ConvertFrom-Json
        if ($response.Error) { throw $response.Error }
        return $response
    } finally { $pipe.Dispose() }
}

$original = Send-CalibrationCommand -Action 'snapshot'
$wmiPanels = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness | Where-Object Active)
$panels = @($original.Displays | Where-Object {
    $display = $_
    @($wmiPanels | Where-Object { $_.InstanceName.Equals($display.Id, [StringComparison]::OrdinalIgnoreCase) -or
        $_.InstanceName.StartsWith($display.Id + '_', [StringComparison]::OrdinalIgnoreCase) }).Count -eq 1
})
if ($panels.Count -ne 1 -or -not $panels[0].CanAdjustColor) { throw '未能唯一识别可调色的内屏。' }
$panel = $panels[0]
$previousCalibration = $null
if ($null -ne $original.Settings.TemperatureBrightnessCalibrations) {
    $previousCalibration = $original.Settings.TemperatureBrightnessCalibrations.PSObject.Properties[$panel.Id].Value
}
$calibrationSuspended = $false
$screen = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Primary -eq $panel.IsPrimary })
if ($screen.Count -ne 1) { throw '无法确定内屏位置。' }
$daily = [Math]::Clamp([int]$panel.Brightness, 25, 50)
$dim = [Math]::Max(10, [Math]::Round($daily / 2))
$script:calibrationSteps = @(
    @{ReferenceBrightness=$daily;Kelvin=4500;Name='日常亮度 · 偏暖'},
    @{ReferenceBrightness=$daily;Kelvin=2700;Name='日常亮度 · 较暖'},
    @{ReferenceBrightness=$dim;Kelvin=4500;Name='偏暗亮度 · 偏暖'},
    @{ReferenceBrightness=$dim;Kelvin=2700;Name='偏暗亮度 · 较暖'}
)
$script:calibrationIndex = 0
$script:calibrationWarm = $false
$script:calibrationPoints = [System.Collections.Generic.List[object]]::new()
$script:calibrationComplete = $false
$pausedFocus = $original.Settings.FocusEnabled -and -not $original.FocusPaused

$form = [System.Windows.Forms.Form]::new()
$form.Text = '内屏冷暖与亮度校准'
$form.StartPosition = 'Manual'
$form.Size = [System.Drawing.Size]::new(640, 450)
$form.Location = [System.Drawing.Point]::new(($screen[0].Bounds.Left + 55), ($screen[0].Bounds.Top + 70))
$form.BackColor = [System.Drawing.Color]::White
$form.TopMost = $true
$form.FormBorderStyle = 'FixedToolWindow'
$label = [System.Windows.Forms.Label]::new()
$label.Dock = 'Fill'
$label.TextAlign = 'MiddleCenter'
$label.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 14)
$form.Controls.Add($label)
$controls = [System.Windows.Forms.Panel]::new()
$controls.Dock = 'Bottom'
$controls.Height = 135
$slider = [System.Windows.Forms.TrackBar]::new()
$slider.Minimum = 0
$slider.Maximum = 100
$slider.TickFrequency = 10
$slider.Dock = 'Top'
$slider.Height = 45
$controls.Controls.Add($slider)
$buttons = [System.Windows.Forms.FlowLayoutPanel]::new()
$buttons.Dock = 'Bottom'
$buttons.Height = 80
foreach ($text in @('看原色参照', '看暖色并调节', '一样亮，记录下一步', '取消并恢复')) {
    $button = [System.Windows.Forms.Button]::new()
    $button.Text = $text
    $button.AutoSize = $true
    $button.Height = 34
    $buttons.Controls.Add($button)
}
$controls.Controls.Add($buttons)
$form.Controls.Add($controls)

function Update-CalibrationLabel {
    $step = $script:calibrationSteps[$script:calibrationIndex]
    $mode = if ($script:calibrationWarm) { '暖色：拖动下方滑条，匹配原色的明亮程度' } else { '原色参照：记住白色区域的明亮程度' }
    $label.Text = "第 $($script:calibrationIndex + 1)/4 步 · $($step.Name)`n$mode`n原色背光 $($step.ReferenceBrightness)% · 暖色背光 $($slider.Value)%`n可反复切换比较，匹配后记录下一步"
}
function Show-CalibrationReference {
    $script:calibrationWarm = $false
    $slider.Enabled = $false
    $step = $script:calibrationSteps[$script:calibrationIndex]
    $null = Send-CalibrationCommand -Action 'brightness' -Id $panel.Id -Value $step.ReferenceBrightness
    $null = Send-CalibrationCommand -Action 'temperature' -Id $panel.Id -Value 6500
    Update-CalibrationLabel
}
function Show-CalibrationWarm {
    $step = $script:calibrationSteps[$script:calibrationIndex]
    $null = Send-CalibrationCommand -Action 'temperature' -Id $panel.Id -Value $step.Kelvin
    $null = Send-CalibrationCommand -Action 'brightness' -Id $panel.Id -Value $slider.Value
    $script:calibrationWarm = $true
    $slider.Enabled = $true
    Update-CalibrationLabel
}
$buttons.Controls[0].Add_Click({ try { Show-CalibrationReference } catch { $label.Text = $_.Exception.Message } })
$buttons.Controls[1].Add_Click({ try { Show-CalibrationWarm } catch { $label.Text = $_.Exception.Message } })
$slider.Add_ValueChanged({
    if ($script:calibrationWarm) {
        try { $null = Send-CalibrationCommand -Action 'brightness' -Id $panel.Id -Value $slider.Value; Update-CalibrationLabel }
        catch { $label.Text = $_.Exception.Message }
    }
})
$buttons.Controls[2].Add_Click({
    try {
        if (-not $script:calibrationWarm) { throw '请先切到暖色并比较亮度。' }
        $step = $script:calibrationSteps[$script:calibrationIndex]
        if ($slider.Value -lt $step.ReferenceBrightness) { throw '本次只校准变暖后的补光，请将暖色亮度设为不低于原色。' }
        foreach ($point in $script:calibrationPoints) {
            if ($point.Kelvin -eq $step.Kelvin -and $point.ReferenceBrightness -gt $step.ReferenceBrightness -and $point.CompensatedBrightness -lt $slider.Value) { throw '偏暗档的背光应不高于已记录的日常档，请重新比较。' }
            if ($point.ReferenceBrightness -eq $step.ReferenceBrightness -and $point.Kelvin -gt $step.Kelvin -and $point.CompensatedBrightness -gt $slider.Value) { throw '较暖档的补光应不低于偏暖档，请重新比较。' }
        }
        $state = Send-CalibrationCommand -Action 'snapshot'
        $current = @($state.Displays | Where-Object Id -eq $panel.Id)[0]
        if ($current.Error) { throw $current.Error }
        if ($current.Brightness -ne $slider.Value -or $current.Kelvin -ne $step.Kelvin) { throw '当前设置被其他操作改变，请重新点击「看暖色并调节」并比较后记录。' }
        $actual = @()
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            $actual = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness | Where-Object {
                $_.Active -and ($_.InstanceName.Equals($panel.Id, [StringComparison]::OrdinalIgnoreCase) -or
                    $_.InstanceName.StartsWith($panel.Id + '_', [StringComparison]::OrdinalIgnoreCase))
            })
            if ($actual.Count -eq 1 -and [int]$actual[0].CurrentBrightness -eq $slider.Value) { break }
            Start-Sleep -Milliseconds 150
        }
        if ($actual.Count -ne 1 -or [int]$actual[0].CurrentBrightness -ne $slider.Value) { throw '实际背光未达到校准值，请重新点击「看暖色并调节」后再比较。' }
        $script:calibrationPoints.Add([pscustomobject]@{Kelvin=$step.Kelvin;ReferenceBrightness=[int]$step.ReferenceBrightness;CompensatedBrightness=[int]$slider.Value})
        Write-Output ('Recorded: ' + ($script:calibrationPoints[$script:calibrationPoints.Count - 1] | ConvertTo-Json -Compress))
        if (++$script:calibrationIndex -ge $script:calibrationSteps.Count) {
            $result = [pscustomobject]@{DisplayId=$panel.Id;Points=@($script:calibrationPoints.ToArray())}
            $outputDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($OutputPath))
            New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
            $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding utf8
            $script:calibrationComplete = $true
            $form.Close()
        } else {
            $slider.Value = [int]$script:calibrationSteps[$script:calibrationIndex].ReferenceBrightness
            Show-CalibrationReference
        }
    } catch { $label.Text = $_.Exception.Message }
})
$buttons.Controls[3].Add_Click({ $form.Close() })
try {
    if ($null -ne $previousCalibration) {
        $settings = (Send-CalibrationCommand -Action 'snapshot').Settings
        $settings.TemperatureBrightnessCalibrations.PSObject.Properties.Remove($panel.Id)
        $null = Send-CalibrationCommand -Action 'save' -Settings $settings
        $calibrationSuspended = $true
    }
    if ($pausedFocus) { $null = Send-CalibrationCommand -Action 'pause' }
    $null = Send-CalibrationCommand -Action 'link' -Value 0
    $slider.Value = $daily
    Show-CalibrationReference
    [System.Windows.Forms.Application]::Run($form)
} finally {
    $form.Dispose()
    $null = Send-CalibrationCommand -Action 'brightness' -Id $panel.Id -Value $panel.Brightness
    if ($null -eq $panel.Kelvin) {
        # A native endpoint is equivalent to this application's restored Gamma baseline.
        $null = Send-CalibrationCommand -Action 'temperature' -Id $panel.Id -Value 6500
    } else { $null = Send-CalibrationCommand -Action 'temperature' -Id $panel.Id -Value $panel.Kelvin }
    if ($original.Settings.Linked) { $null = Send-CalibrationCommand -Action 'link' -Value 1 }
    if ($calibrationSuspended) {
        $settings = (Send-CalibrationCommand -Action 'snapshot').Settings
        $settings.TemperatureBrightnessCalibrations | Add-Member -NotePropertyName $panel.Id -NotePropertyValue $previousCalibration -Force
        $null = Send-CalibrationCommand -Action 'save' -Settings $settings
    }
    if ($pausedFocus) {
        $state = Send-CalibrationCommand -Action 'snapshot'
        if ($state.FocusPaused) { $null = Send-CalibrationCommand -Action 'pause' }
    }
    Write-Output ('Calibration completed=' + $script:calibrationComplete)
    Write-Output 'Original brightness, temperature and linking restored.'
}
