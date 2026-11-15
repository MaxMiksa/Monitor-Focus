param([Parameter(Mandatory)][string]$Executable,[ValidatePattern('^[a-z0-9-]+$')][string]$EvidencePrefix=('update-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')),[switch]$Restart)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/NativeControl.ps1"
$projectRoot=Split-Path $PSScriptRoot -Parent
$evidence=Join-Path $projectRoot 'build/diagnostics'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$Executable=(Resolve-Path -LiteralPath $Executable).Path
if([IO.Path]::GetFileName($Executable) -ne 'MonitorsFocus.Go.exe'){throw 'Use a product build'}
$owners=@(Get-CimInstance Win32_Process -Filter "Name='MonitorsFocus.Go.exe'")
if($owners.Count -ne 1 -or @(Get-Process MonitorsFocus -ErrorAction SilentlyContinue).Count){throw 'Need one exclusive Go core'}
$oldPath=$owners[0].ExecutablePath
if($oldPath -eq $Executable -and -not $Restart){throw 'Use a new immutable package path or explicit -Restart'}
$before=Send-Go
if($before.Displays.Count -lt 1 -or @($before.Displays|Where-Object Error).Count){throw 'Hardware state needs attention'}
$before|ConvertTo-Json -Depth 40|Set-Content "$evidence/$EvidencePrefix-before.json"
$oldProcess=Get-Process -Id $owners[0].ProcessId
$wasOpen=$oldProcess.MainWindowHandle -ne 0
$newProcess=$null;$updated=$false;$exited=$false
function Restore-Latest {
    $s=Send-Go
    if($s.FocusPaused -ne $before.FocusPaused){$s=Send-Go @{Action='pause'}}
    $source=$before.Settings.BrightnessLinkCalibration.SourceId
    $displays=if($before.Settings.Linked -and $source){@($before.Displays|Where-Object Id -eq $source)}else{@($before.Displays)}
    foreach($d in $displays){$null=Send-Go @{Action='brightness';Id=$d.Id;Value=$d.Brightness}}
    foreach($d in $before.Displays){$r=@{Action=if($null -eq $d.Kelvin){'restore-color'}else{'temperature'};Id=$d.Id};if($null -ne $d.Kelvin){$r.Value=$d.Kelvin};$null=Send-Go $r}
}
function Wait-Hardware {
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    do{Start-Sleep -Milliseconds 200;try{$s=Send-Go}catch{$s=$null}}while((-not $s -or $s.Displays.Count -ne $before.Displays.Count) -and [DateTime]::UtcNow -lt $deadline)
    if(-not $s -or $s.Displays.Count -ne $before.Displays.Count){throw 'Core hardware not ready'}
}
try {
    $null=Send-Go @{Action='host-exit'}
    if(-not $oldProcess.WaitForExit(20000)){throw 'Previous core did not exit normally'}
    $exited=$true
    $newProcess=Start-Process $Executable -ArgumentList '--mode native --hardware --production --background' -PassThru -WindowStyle Hidden
    Wait-Hardware;Restore-Latest
    $now=Send-Go
    $matches=$true;foreach($d in $before.Displays){$n=$now.Displays|Where-Object Id -eq $d.Id;if($n.Brightness -ne $d.Brightness -or $n.Kelvin -ne $d.Kelvin -or $n.Error){$matches=$false}}
    $startup=(Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Run' -Name MonitorsFocus).MonitorsFocus
    $expected='"'+$Executable+'" --mode native --hardware --production --background'
    if(-not $matches -or $now.FocusPaused -ne $before.FocusPaused -or $now.Warning -or $startup -ne $expected){throw 'Updated core final state mismatch'}
    if($wasOpen){$null=Send-Go @{Action='host-open'}}
    $updated=$true
    @{At=(Get-Date).ToString('o');Updated=$true;Executable=$Executable;PreviousExecutable=$oldPath;Pid=$newProcess.Id;TargetsPreserved=$matches;FocusPreserved=$true;Startup=$startup;Error=$now.Error;Warning=$now.Warning}|ConvertTo-Json|Set-Content "$evidence/$EvidencePrefix-update.json"
}finally {
    if(-not $updated -and $exited){
        if($newProcess){$newProcess.Refresh();if(-not $newProcess.HasExited){$null=Send-Go @{Action='host-exit'};if(-not $newProcess.WaitForExit(20000)){throw 'Cannot drain new core; refused concurrent rollback'}}}
        $null=Start-Process $oldPath -ArgumentList '--mode native --hardware --production --background' -PassThru -WindowStyle Hidden
        Wait-Hardware;Restore-Latest
        if($wasOpen){$null=Send-Go @{Action='host-open'}}
    }
}
if($updated){
    & "$PSScriptRoot/Remove-OldPackages.ps1" | ConvertTo-Json -Depth 4 | Set-Content "$evidence/$EvidencePrefix-retention.json"
}
