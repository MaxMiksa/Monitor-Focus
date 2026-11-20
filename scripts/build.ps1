param([string]$Go='D:\Apps\go\bin\go.exe',[string]$Pnpm='D:\Apps\pnpm\12.16.1\pnpm.exe',[switch]$Check,[switch]$Package,[string]$SourceOverlay)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    if (@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'MyScreen.exe' -and $_.ExecutablePath -eq "$root\build\MyScreen.exe" }).Count) { throw '正常退出构建目录中的程序后再构建；现用发布包可继续运行。' }
    $all=[Diagnostics.Stopwatch]::StartNew()
    $version=& $Pnpm --version
    if ($LASTEXITCODE -or $version.Trim() -ne '12.16.1') { throw 'pnpm 12.16.1 required' }
    $goVersion=& $Go version
    $overlay=& "$PSScriptRoot/New-GoMemoryOverlay.ps1" -Go $Go
    if ($SourceOverlay) {
        # Isolate other ongoing Go edits without changing their working files.
        $merged = Get-Content -LiteralPath $overlay -Raw | ConvertFrom-Json -AsHashtable
        $sources = Get-Content -LiteralPath $SourceOverlay -Raw | ConvertFrom-Json -AsHashtable
        foreach ($sourcePath in $sources.Replace.Keys) {
            $absolute = [IO.Path]::GetFullPath($sourcePath)
            if (-not $absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or -not $absolute.EndsWith('.go', [StringComparison]::OrdinalIgnoreCase)) { throw 'Source overlays must identify Go files within this project.' }
            $replacement = $sources.Replace[$sourcePath]
            if ($replacement -and -not (Test-Path -LiteralPath $replacement -PathType Leaf)) { throw 'Source overlay replacement is missing.' }
            $merged.Replace[$absolute] = $replacement
        }
        $overlay = Join-Path $root 'build/go-memory-overlay/production-overlay.json'
        [IO.File]::WriteAllText($overlay, ($merged | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    }
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
    & $Go build "-overlay=$overlay" -mod=readonly -trimpath -tags production -ldflags '-s -w -H windowsgui -X main.adoptedBuild=true' -o build/MyScreen.exe .
    if ($LASTEXITCODE) { throw 'Windows production build failed' }
    & "$PSScriptRoot/Set-ExecutableIcon.ps1" -Executable "$root/build/MyScreen.exe"
    # Verify the stripped executable's writable image section; no symbols needed.
    $stream=[IO.File]::OpenRead((Join-Path $root 'build/MyScreen.exe'))
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
    @{At=(Get-Date).ToString('o');Go=$goVersion;Pnpm=$version.Trim();FrontendBuildMs=$web.Elapsed.TotalMilliseconds;GoBuildMs=$native.Elapsed.TotalMilliseconds;TotalMs=$all.Elapsed.TotalMilliseconds;Checks=[bool]$Check;ExecutableBytes=(Get-Item build/MyScreen.exe).Length} | ConvertTo-Json -Compress | Add-Content build/build-timing.jsonl
    Write-Host "$root\build\MyScreen.exe"
    if ($Package) {
        $output = Join-Path $root ('build/packages/' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
        New-Item -ItemType Directory -Path $output | Out-Null
        Copy-Item -LiteralPath "$root/build/MyScreen.exe" -Destination $output
        Write-Host "Package: $output\MyScreen.exe"
    }
} finally { Pop-Location }
