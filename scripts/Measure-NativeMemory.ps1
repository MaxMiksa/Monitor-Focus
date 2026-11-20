param([Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$Label)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/NativeControl.ps1"
$projectRoot=Split-Path $PSScriptRoot -Parent
$evidence=Join-Path $projectRoot 'build/diagnostics'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$output=Join-Path $evidence "$Label-processes.jsonl"
if(Test-Path -LiteralPath $output){throw 'Refusing to overwrite previous measurements'}
if(-not ('NativeMemoryWindow' -as [type])){
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeMemoryWindow {
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int size);
 public static bool Visible(int processId) {bool found=false;EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);if(id==processId&&IsWindowVisible(h)){var text=new StringBuilder(256);GetWindowText(h,text,256);var title=text.ToString();if(title=="MyScreen"){found=true;return false;}}return true;},IntPtr.Zero);return found;}
}
'@
}
$owner=@(Get-CimInstance Win32_Process -Filter "Name='MyScreen.exe'")
if($owner.Count -ne 1){throw 'Need one product Go process'}
$rootId=[int]$owner[0].ProcessId
$wasOpen=[NativeMemoryWindow]::Visible($rootId)
$before=Send-Go
$rows=[Collections.Generic.List[object]]::new()
$timings=[Collections.Generic.List[object]]::new()
function Owned-Processes {
    $all=@(Get-CimInstance Win32_Process)
    if(@($all|Where-Object {$_.ProcessId -eq $rootId}).Count -ne 1){throw 'Core changed during measurement'}
    $ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add($rootId)
    do{$added=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$added=$true}}}while($added)
    return @($all|Where-Object {$ids.Contains([int]$_.ProcessId)})
}
function Wait-Panel([bool]$Open) {
    $limit=[DateTime]::UtcNow.AddSeconds(12)
    do {
        $visible=[NativeMemoryWindow]::Visible($rootId)
        if($Open -and $visible){return}
        if(-not $Open -and -not $visible -and @(Owned-Processes|Where-Object Name -eq 'msedgewebview2.exe').Count -eq 0){return}
        Start-Sleep -Milliseconds 40
    }while([DateTime]::UtcNow -lt $limit)
    throw 'Panel lifecycle did not complete'
}
function Sample-Phase([string]$Phase) {
    for($i=0;$i -lt 3;$i++){
        $owned=@(Owned-Processes)
        $perf=@(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process|Where-Object {$_.IDProcess -in $owned.ProcessId})
        if($owned.Count -ne $perf.Count){throw 'Incomplete owned-process counters'}
        $webviews=@($owned|Where-Object Name -eq 'msedgewebview2.exe').Count
        if(($Phase -like 'open-*') -ne ($webviews -gt 0)){throw 'Unexpected WebView2 lifecycle'}
        $row=[pscustomobject][ordered]@{At=(Get-Date).ToString('o');Phase=$Phase;Sample=$i;ProcessCount=$owned.Count;WebViews=$webviews;PrivateBytes=($perf|Measure-Object PrivateBytes -Sum).Sum;PrivateWorkingSet=($perf|Measure-Object WorkingSetPrivate -Sum).Sum;CpuPercentOneCore=($perf|Measure-Object PercentProcessorTime -Sum).Sum;Handles=($owned|Measure-Object HandleCount -Sum).Sum;Threads=($owned|Measure-Object ThreadCount -Sum).Sum}
        $rows.Add($row)
        $row|ConvertTo-Json -Compress|Add-Content -LiteralPath $output -Encoding utf8
        Start-Sleep -Milliseconds 700
    }
}
try {
    $null=Send-Go @{Action='host-close'};Wait-Panel $false
    Sample-Phase 'background'
    for($cycle=1;$cycle -le 5;$cycle++){
        $clock=[Diagnostics.Stopwatch]::StartNew()
        $null=Send-Go @{Action='host-open'};Wait-Panel $true
        $clock.Stop();$timings.Add([pscustomobject]@{Cycle=$cycle;VisibleWindowMs=$clock.Elapsed.TotalMilliseconds})
        Sample-Phase "open-$cycle"
        $null=Send-Go @{Action='host-close'};Wait-Panel $false
        Sample-Phase "closed-$cycle"
    }
    $diagnostic=Send-Go @{Action='host-memory'}
    $after=Send-Go
    $summary=[ordered]@{At=(Get-Date).ToString('o');Label=$Label;Executable=$owner[0].ExecutablePath;Pid=$rootId;Definition='Decimal MB; owned core and all descendant WebView2; three samples per phase; visible HWND time is not interactive-ready time';InitialState=$before;FinalState=$after;Samples=@($rows.ToArray());OpenTimings=@($timings.ToArray());FinalDiagnostic=$diagnostic}
    $summary|ConvertTo-Json -Depth 40|Set-Content (Join-Path $evidence "$Label.json") -Encoding utf8
    $last=@($rows|Where-Object Phase -eq 'closed-5'|Sort-Object PrivateBytes)
    [ordered]@{Label=$Label;Closed5PrivateBytesMB=$last[1].PrivateBytes/1e6;Closed5PrivateWorkingSetMB=(@($last|Sort-Object PrivateWorkingSet)[1].PrivateWorkingSet)/1e6;Closed5Cpu=(@($last|Sort-Object CpuPercentOneCore)[1].CpuPercentOneCore);MedianVisibleWindowMs=(@($timings|Sort-Object VisibleWindowMs)[2].VisibleWindowMs)}|ConvertTo-Json
}finally {
    $null=Send-Go @{Action=if($wasOpen){'host-open'}else{'host-close'}}
}
