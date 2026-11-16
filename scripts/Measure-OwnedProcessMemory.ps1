param([Parameter(Mandatory)][int]$OwnerId)
$ErrorActionPreference = 'Stop'
# One snapshot, with explicit ownership. Shared working sets are not additive.
$all = @(Get-CimInstance Win32_Process)
$owner = @($all | Where-Object ProcessId -eq $OwnerId)
if ($owner.Count -ne 1 -or $owner[0].Name -ne 'MonitorsFocus.Go.exe') { throw 'Expected one identified MonitorsFocus owner.' }
$ids = [Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($OwnerId)
do {
    $added = $false
    foreach ($process in $all) {
        if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) { $added = $true }
    }
} while ($added)
$owned = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) })
$counters = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids.Contains([int]$_.IDProcess) })
if ($counters.Count -ne $owned.Count) { throw 'Process tree changed during snapshot; retry instead of recording incomplete totals.' }
$gpu = @()
$gpuAvailable = $true
try {
    $gpu = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object {
        $_.Name -match '^pid_(\d+)_' -and $ids.Contains([int]$Matches[1])
    })
} catch { $gpuAvailable = $false }
[ordered]@{
    At = [DateTime]::UtcNow.ToString('o')
    OwnerId = $OwnerId
    Executable = $owner[0].ExecutablePath
    Definition = 'Bytes; private resident and private committed are distinct; GPU shared usage is system graphics memory, not shared working set.'
    PrivateWorkingSet = ($counters | Measure-Object WorkingSetPrivate -Sum).Sum
    PrivateBytes = ($counters | Measure-Object PrivateBytes -Sum).Sum
    WebViews = @($owned | Where-Object Name -eq 'msedgewebview2.exe').Count
    GpuCountersAvailable = $gpuAvailable
    GpuDedicatedBytes = if ($gpuAvailable) { ($gpu | Measure-Object DedicatedUsage -Sum).Sum } else { $null }
    GpuSharedBytes = if ($gpuAvailable) { ($gpu | Measure-Object SharedUsage -Sum).Sum } else { $null }
    Processes = @($counters | ForEach-Object {
        $counter = $_
        $process = $owned | Where-Object ProcessId -eq $counter.IDProcess
        [ordered]@{ Id = $counter.IDProcess; Name = $process.Name; Created = $process.CreationDate; PrivateWorkingSet = $counter.WorkingSetPrivate; PrivateBytes = $counter.PrivateBytes }
    })
} | ConvertTo-Json -Depth 5 -Compress
