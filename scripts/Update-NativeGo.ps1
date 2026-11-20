param([Parameter(Mandatory)][string]$Executable,[ValidatePattern('^[a-z0-9-]+$')][string]$EvidencePrefix=('update-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')),[switch]$Restart)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/NativeControl.ps1"
$projectRoot=Split-Path $PSScriptRoot -Parent
$evidence=Join-Path $projectRoot 'build/diagnostics'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$Executable=(Resolve-Path -LiteralPath $Executable).Path
if([IO.Path]::GetFileName($Executable) -ne 'MyScreen.exe'){throw 'Use a product build'}
$owners=@(Get-CimInstance Win32_Process -Filter "Name='MyScreen.exe' OR Name='MonitorsFocus.Go.exe'")
if($owners.Count -ne 1 -or @(Get-Process MonitorsFocus -ErrorAction SilentlyContinue).Count){throw 'Need one exclusive Go core'}
$oldPath=$owners[0].ExecutablePath
$legacy=$owners[0].Name -eq 'MonitorsFocus.Go.exe'
if($oldPath -eq $Executable -and -not $Restart){throw 'Use a new immutable package path or explicit -Restart'}
$before=Send-Go -Legacy:$legacy
if($before.Displays.Count -lt 1 -or @($before.Displays|Where-Object Error).Count){throw 'Hardware state needs attention'}
$wasScheduled=$before.Settings.ScheduleEnabled -and ([string]$before.Source).StartsWith('时间计划')
$before|ConvertTo-Json -Depth 40|Set-Content "$evidence/$EvidencePrefix-before.json"
$oldProcess=Get-Process -Id $owners[0].ProcessId
$wasOpen=$oldProcess.MainWindowHandle -ne 0
$newProcess=$null;$updated=$false;$exited=$false
function Restore-Latest {
    param([switch]$Old)
    $s=Send-Go -Legacy:$Old
    if($s.FocusPaused -ne $before.FocusPaused){$s=Send-Go @{Action='pause'} -Legacy:$Old}
    # A running transition has non-rounded targets. Let the plan continue instead
    # of rounding its temperature through manual controls and putting it on hold.
    if($wasScheduled){$null=Send-Go @{Action='resume-plan'} -Legacy:$Old;return}
    $source=$before.Settings.BrightnessLinkCalibration.SourceId
    $displays=if($before.Settings.Linked -and $source){@($before.Displays|Where-Object Id -eq $source)}else{@($before.Displays)}
    foreach($d in $displays){$null=Send-Go @{Action='brightness';Id=$d.Id;Value=$d.Brightness} -Legacy:$Old}
    foreach($d in $before.Displays){$r=@{Action=if($null -eq $d.Kelvin){'restore-color'}else{'temperature'};Id=$d.Id};if($null -ne $d.Kelvin){$r.Value=$d.Kelvin};$null=Send-Go $r -Legacy:$Old}
}
function Wait-Hardware {
    param([switch]$Old)
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    do{Start-Sleep -Milliseconds 200;try{$s=Send-Go -Legacy:$Old}catch{$s=$null}}while((-not $s -or $s.Displays.Count -ne $before.Displays.Count) -and [DateTime]::UtcNow -lt $deadline)
    if(-not $s -or $s.Displays.Count -ne $before.Displays.Count){throw 'Core hardware not ready'}
}
try {
    $null=Send-Go @{Action='host-exit'} -Legacy:$legacy
    if(-not $oldProcess.WaitForExit(20000)){throw 'Previous core did not exit normally'}
    $exited=$true
    $newProcess=Start-Process $Executable -ArgumentList '--mode native --hardware --production --background' -PassThru -WindowStyle Hidden
    Wait-Hardware;Restore-Latest
    $now=Send-Go
    $matches=$true;foreach($d in $before.Displays){$n=@($now.Displays|Where-Object Id -eq $d.Id);if($n.Count -ne 1 -or $n[0].Error -or (-not $wasScheduled -and ($n[0].Brightness -ne $d.Brightness -or $n[0].Kelvin -ne $d.Kelvin))){$matches=$false}}
    if($wasScheduled -and ((-not ([string]$now.Source).StartsWith('时间计划')) -or $now.Settings.Revision -ne $before.Settings.Revision)){$matches=$false}
    $run=Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Run'
    $startup=$run.MyScreen
    $expected='"'+$Executable+'" --mode native --hardware --production --background'
    if(-not $before.Settings.LaunchOnStartup){$expected=$null}
    if(-not $matches -or $now.FocusPaused -ne $before.FocusPaused -or $now.Error -or $now.Warning -or $startup -ne $expected -or $run.MonitorsFocus -or $run.'MonitorsFocus.ControlCenter'){throw 'Updated core final state mismatch'}
    if($wasOpen){$null=Send-Go @{Action='host-open'}}
    $updated=$true
    @{At=(Get-Date).ToString('o');Updated=$true;Executable=$Executable;PreviousExecutable=$oldPath;Pid=$newProcess.Id;TargetsPreserved=($matches -and -not $wasScheduled);PlanResumed=[bool]$wasScheduled;FocusPreserved=$true;Startup=$startup;Error=$now.Error;Warning=$now.Warning}|ConvertTo-Json|Set-Content "$evidence/$EvidencePrefix-update.json"
}finally {
    if(-not $updated -and $exited){
        if($newProcess){$newProcess.Refresh();if(-not $newProcess.HasExited){$null=Send-Go @{Action='host-exit'};if(-not $newProcess.WaitForExit(20000)){throw 'Cannot drain new core; refused concurrent rollback'}}}
        $null=Start-Process $oldPath -ArgumentList '--mode native --hardware --production --background' -PassThru -WindowStyle Hidden
        Wait-Hardware -Old:$legacy;Restore-Latest -Old:$legacy
        if($legacy){
            # An older binary can only register its own name. Retire the new one
            # after the rollback core has initialized successfully.
            foreach($key in 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Run','HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/StartupApproved/Run'){
                Remove-ItemProperty -LiteralPath $key -Name MyScreen -ErrorAction SilentlyContinue
            }
        }
        if($wasOpen){$null=Send-Go @{Action='host-open'} -Legacy:$legacy}
    }
}
if($updated){
    & "$PSScriptRoot/Remove-OldPackages.ps1" | ConvertTo-Json -Depth 4 | Set-Content "$evidence/$EvidencePrefix-retention.json"
}
