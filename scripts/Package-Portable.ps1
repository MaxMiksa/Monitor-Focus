param(
    [Parameter(Mandatory)][ValidatePattern('^v\d+\.\d+\.\d+$')][string]$Version,
    [string]$Go='D:\Apps\go\bin\go.exe',
    [string]$Pnpm='D:\Apps\pnpm\12.16.1\pnpm.exe'
)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$exe=Join-Path $root 'build/MyScreen.exe'
$destination=Join-Path $root "build/releases/$Version"
$zipPath=Join-Path $destination 'MyScreen-windows-x64.zip'

if (Test-Path -LiteralPath $zipPath) { throw 'A ZIP already exists for this version.' }
$reader=[IO.BinaryReader]::new([IO.File]::OpenRead($exe))
try {
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'Expected a Windows executable.' }
    $reader.BaseStream.Position=0x3c
    $reader.BaseStream.Position=$reader.ReadUInt32()
    if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Expected a Windows x64 build.' }
} finally { $reader.Dispose() }

$notices=[Text.StringBuilder]::new()
function Add-Notices($label, $folder) {
    $files=@(Get-ChildItem -LiteralPath $folder -File | Where-Object Name -Match '^(LICEN[CS]E|COPYING|NOTICE|AUTHORS|COPYRIGHT|PATENTS)([.-]|$)' | Sort-Object Name)
    foreach ($file in $files) {
        $null=$notices.AppendLine("$label / $($file.Name)").AppendLine([IO.File]::ReadAllText($file.FullName).TrimEnd()).AppendLine()
    }
    return $files.Count
}

Push-Location $root
try {
    $goRoot=& $Go env GOROOT
    if ($LASTEXITCODE -or (Add-Notices 'Go standard library' $goRoot) -eq 0) { throw 'Go license not found.' }
    $goPackages=& $Go list -tags production -deps -f '{{with .Module}}{{if not .Main}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}{{end}}|{{.Dir}}' .
    if ($LASTEXITCODE) { throw 'Go dependency listing failed.' }
    $seen=@{}
    foreach ($entry in $goPackages) {
        if ($entry.StartsWith('|')) { continue }
        $name,$version,$moduleDir,$folder=$entry -split '\|',4
        $prefix=$moduleDir+[IO.Path]::DirectorySeparatorChar
        while ($folder -eq $moduleDir -or $folder.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) {
            if (!$seen.ContainsKey($folder)) {
                $seen[$folder]=$true
                $relative=[IO.Path]::GetRelativePath($moduleDir,$folder)
                $count=Add-Notices "$name $version ($relative)" $folder
                if ($folder -eq $moduleDir -and !$count) { throw "Missing Go module license: $name" }
            }
            if ($folder -eq $moduleDir) { break }
            $folder=Split-Path $folder -Parent
        }
    }
    $catalog=& $Pnpm --dir frontend licenses list --prod --json
    if ($LASTEXITCODE) { throw 'Frontend dependency listing failed.' }
    $groups=($catalog -join "`n") | ConvertFrom-Json -AsHashtable
    foreach ($group in $groups.Values) {
        foreach ($dependency in $group) {
            # Native Rollup tooling is not in the Windows distribution.
            if ($dependency.name -like '@rolldown/binding-*') { continue }
            foreach ($folder in $dependency.paths) {
                $manifest=Get-Content -LiteralPath (Join-Path $folder 'package.json') -Raw | ConvertFrom-Json
                if (!(Add-Notices "$($manifest.name) $($manifest.version)" $folder) -and $manifest.name -ne 'react-remove-scroll-bar') {
                    throw "Missing frontend license: $($manifest.name)"
                }
                # react-remove-scroll-bar's npm tarball omits its license; see THIRD_PARTY_NOTICES.md.
            }
        }
    }

    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $zip=[IO.Compression.ZipFile]::Open($zipPath,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in 'MyScreen.exe','LICENSE','THIRD_PARTY_NOTICES.md') {
            $path=if ($name -eq 'MyScreen.exe') { $exe } else { Join-Path $root $name }
            $null=[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$path,$name,[IO.Compression.CompressionLevel]::Optimal)
        }
        $writer=[IO.StreamWriter]::new($zip.CreateEntry('DEPENDENCY_LICENSES.txt').Open())
        try { $writer.Write($notices.ToString()) } finally { $writer.Dispose() }
    } finally { $zip.Dispose() }
    Get-Item -LiteralPath $zipPath
} finally { Pop-Location }
