param([string]$Go='D:\Apps\go\bin\go.exe',[string]$Pnpm='D:\Apps\pnpm\12.16.1\pnpm.exe',[switch]$Check,[switch]$Package)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    if (@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'MonitorsFocus.Go.exe' -and $_.ExecutablePath -eq "$root\build\MonitorsFocus.Go.exe" }).Count) { throw '正常退出构建目录中的程序后再构建；现用发布包可继续运行。' }
    $all=[Diagnostics.Stopwatch]::StartNew()
    $version=& $Pnpm --version
    if ($LASTEXITCODE -or $version.Trim() -ne '12.16.1') { throw 'pnpm 12.16.1 required' }
    $goVersion=& $Go version
    $overlay=& "$PSScriptRoot/New-GoMemoryOverlay.ps1" -Go $Go
    & $Pnpm --dir frontend install --frozen-lockfile
    if ($LASTEXITCODE) { throw 'Frontend restore failed' }
    $web=[Diagnostics.Stopwatch]::StartNew()
    & $Pnpm --dir frontend run build
    if ($LASTEXITCODE) { throw 'Frontend build failed' }
    $web.Stop()
    & $Go mod download
    if ($LASTEXITCODE) { throw 'Locked Go dependency restore failed' }
    if ($Check) {
        & $Pnpm --dir frontend run lint
        if ($LASTEXITCODE) { throw 'Frontend lint failed' }
        & $Go test "-overlay=$overlay" ./...
        if ($LASTEXITCODE) { throw 'Go checks failed' }
        & $Go vet "-overlay=$overlay" ./...
        if ($LASTEXITCODE) { throw 'Go vet failed' }
    }
    $native=[Diagnostics.Stopwatch]::StartNew()
    & $Go build "-overlay=$overlay" -mod=readonly -trimpath -tags production -ldflags '-s -w -H windowsgui -X main.adoptedBuild=true' -o build/MonitorsFocus.Go.exe .
    if ($LASTEXITCODE) { throw 'Windows production build failed' }
    # Verify the stripped executable's writable image section; no symbols needed.
    $stream=[IO.File]::OpenRead((Join-Path $root 'build/MonitorsFocus.Go.exe'))
    try {
        $reader=[IO.BinaryReader]::new($stream)
        $stream.Position=0x3c;$header=$reader.ReadInt32()
        $stream.Position=$header+6;$sections=$reader.ReadUInt16()
        $stream.Position=$header+20;$optional=$reader.ReadUInt16()
        $dataBytes=$null
        for($i=0;$i -lt $sections;$i++){
            $stream.Position=$header+24+$optional+40*$i
            $name=[Text.Encoding]::ASCII.GetString($reader.ReadBytes(8)).Trim([char]0)
            $size=$reader.ReadUInt32()
            if($name -eq '.data'){$dataBytes=$size}
        }
        if($null -eq $dataBytes -or $dataBytes -ge 8MB){throw 'Large writable image section remains; entropy overlay needs review.'}
    } finally { $stream.Dispose() }
    @{At=(Get-Date).ToString('o');Go=$goVersion;Pnpm=$version.Trim();FrontendBuildMs=$web.Elapsed.TotalMilliseconds;GoBuildMs=$native.Elapsed.TotalMilliseconds;TotalMs=$all.Elapsed.TotalMilliseconds;Checks=[bool]$Check;ExecutableBytes=(Get-Item build/MonitorsFocus.Go.exe).Length} | ConvertTo-Json -Compress | Add-Content build/build-timing.jsonl
    Write-Host "$root\build\MonitorsFocus.Go.exe"
    if ($Package) {
        $output = Join-Path $root ('build/packages/' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
        New-Item -ItemType Directory -Path $output | Out-Null
        Copy-Item -LiteralPath "$root/build/MonitorsFocus.Go.exe" -Destination $output
        Write-Host "Package: $output\MonitorsFocus.Go.exe"
    }
} finally { Pop-Location }
