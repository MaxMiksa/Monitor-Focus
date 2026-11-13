param([string]$Go='D:\Apps\go\bin\go.exe')
$ErrorActionPreference='Stop'
# Go issue 81956: the unused FIPS entropy BSS buffer costs 32 MiB of
# Windows private commit. Build-local lazy allocation preserves its algorithm.
# Nothing in the installed SDK or shared module cache is modified.
$root=Split-Path $PSScriptRoot -Parent
$version=(& $Go env GOVERSION).Trim()
if($LASTEXITCODE -or $version -ne 'go1.27.3'){throw 'Recheck the entropy overlay before changing Go 1.27.3.'}
$goRoot=(& $Go env GOROOT).Trim()
if($LASTEXITCODE){throw 'Cannot locate Go source.'}
$original=Join-Path $goRoot 'src/crypto/internal/fips140/drbg/entropy_fips140.go'
$source=[IO.File]::ReadAllText($original)
if(([regex]::Matches($source,'var memory entropy\.ScratchBuffer')).Count -ne 1 -or ([regex]::Matches($source,'entropy\.Seed\(&memory\)')).Count -ne 2 -or -not $source.Contains('import entropy "crypto/internal/entropy/v1.0.0"')){
    throw 'Go entropy source changed; review or remove the overlay.'
}
$source=$source.Replace('import entropy "crypto/internal/entropy/v1.0.0"',"import (`n entropy `"crypto/internal/entropy/v1.0.0`"`n `"sync`"`n)")
$start=$source.IndexOf('// It should end up in the .noptrbss section')
$end=$source.IndexOf('var memory entropy.ScratchBuffer')
if($start -lt 0 -or $end -le $start){throw 'Entropy allocation comment changed.'}
$source=$source.Substring(0,$start)+"// Allocate once on first FIPS entropy request, avoiding unused Windows commit.`n"+$source.Substring($end)
$source=$source.Replace('var memory entropy.ScratchBuffer','var memory = sync.OnceValue(func() *entropy.ScratchBuffer { return new(entropy.ScratchBuffer) })').Replace('entropy.Seed(&memory)','entropy.Seed(memory())')
$directory=Join-Path $root 'build/go-memory-overlay'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$patched=Join-Path $directory 'entropy_fips140.go.overlay'
[IO.File]::WriteAllText($patched,$source,[Text.UTF8Encoding]::new($false))
& (Join-Path (Split-Path $Go -Parent) 'gofmt.exe') -w $patched
if($LASTEXITCODE){throw 'Cannot format entropy overlay.'}
$overlay=Join-Path $directory 'overlay.json'
[IO.File]::WriteAllText($overlay,(@{Replace=@{$original=$patched}}|ConvertTo-Json -Depth 3),[Text.UTF8Encoding]::new($false))
return $overlay
