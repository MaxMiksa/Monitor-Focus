param([string]$Node='D:\Apps\Node\node.exe')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$info=[Diagnostics.ProcessStartInfo]::new($Node)
$info.ArgumentList.Add("$root\frontend\dev-server.mjs")
$info.WorkingDirectory=$root
$info.UseShellExecute=$false
$info.CreateNoWindow=$true
$info.RedirectStandardInput=$true
$server=[Diagnostics.Process]::Start($info)
try {
    Start-Sleep -Milliseconds 700
    if ($server.HasExited) { throw 'Vite failed to start; check 5183 ownership' }
    $app=Start-Process "$root\build\MonitorsFocus.Go.exe" -ArgumentList '--mode mock --hardware=false --production=false --dev' -PassThru
    $app.WaitForExit()
} finally {
    if (-not $server.HasExited) { $server.StandardInput.WriteLine('exit');$server.StandardInput.Flush();if (-not $server.WaitForExit(10000)) { Write-Warning "Vite has not exited yet: PID $($server.Id)" } }
    $server.Dispose()
}
