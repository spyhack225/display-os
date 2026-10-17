param([switch]$ProjectLocal)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = if ($ProjectLocal) { Join-Path $root '.tools' } else { Join-Path $env:LOCALAPPDATA 'DisplayOSKioskToolchain' }
New-Item -ItemType Directory -Path $tools -Force | Out-Null
. (Join-Path $PSScriptRoot 'protect-runtime.ps1')
if (!$ProjectLocal) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & "$env:SystemRoot\System32\icacls.exe" $tools '/inheritance:r' '/grant:r' "*$($sid):(OI)(CI)F" '/Q' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot protect executable toolchain.' }; Assert-KioskPrivate $tools
}
$packages = @(
  @{ Name='jdk'; Url='https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip'; Algorithm='SHA256'; Hash='e53a79c3c3d86865bd7e787903884331068e71321714ffd44f145785affc7cb0' },
  @{ Name='platform'; Url='https://dl.google.com/android/repository/platform-35-ext15_r01.zip'; Algorithm='SHA1'; Hash='ce757091f933b7ac646bf197ce8957cc73b95614' },
  @{ Name='build-tools'; Url='https://dl.google.com/android/repository/build-tools_r35_windows.zip'; Algorithm='SHA1'; Hash='af059bb67cf7786f45ee0db85e2d24985df1b4b6' }
)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$evidence = @()
foreach ($package in $packages) {
  $archive = Join-Path $tools ($package.Name + '.zip')
  $cached = Join-Path (Join-Path $root '.tools') ($package.Name + '.zip')
  if (!$ProjectLocal -and !(Test-Path -LiteralPath $archive) -and (Test-Path -LiteralPath $cached)) {
    if ((Get-FileHash -LiteralPath $cached -Algorithm $package.Algorithm).Hash.ToLower() -ne $package.Hash) { throw 'Cached archive vendor hash differs.' }
    Copy-Item -LiteralPath $cached -Destination $archive
  }
  if (-not (Test-Path -LiteralPath $archive)) {
    & "$env:SystemRoot\System32\curl.exe" --fail --location --retry 3 --silent --show-error --output $archive $package.Url
    if ($LASTEXITCODE -ne 0) { throw ('Download failed for ' + $package.Name) }
  }
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm $package.Algorithm).Hash.ToLowerInvariant()
  if ($actual -ne $package.Hash) { throw ('Vendor hash mismatch for ' + $package.Name + '. Archive not extracted.') }
  $destination = Join-Path $tools $package.Name
  $absolute = [System.IO.Path]::GetFullPath($destination) + [System.IO.Path]::DirectorySeparatorChar
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($entry in $zip.Entries) {
      $target = [System.IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
      if (-not $target.StartsWith($absolute, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive entry escapes tool directory.' }
    }
  } finally { $zip.Dispose() }
  if (!$ProjectLocal -and $package.Name -eq 'platform') {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
      $entries = @($zip.Entries | Where-Object { $_.FullName -match '(^|/)android.jar$' })
      if ($entries.Count -ne 1) { throw 'Platform classpath archive is ambiguous.' }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], (Join-Path $destination 'android.jar'), $true)
    } finally { $zip.Dispose() }
  } elseif (-not (Test-Path -LiteralPath $destination)) {
    Expand-Archive -LiteralPath $archive -DestinationPath $destination
  }
  $evidence += @{ name=$package.Name; url=$package.Url; vendorAlgorithm=$package.Algorithm; vendorHash=$actual; sha256=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() }
  Write-Output ('Verified and available: ' + $package.Name)
}
$java = Get-ChildItem -LiteralPath (Join-Path $tools 'jdk') -Recurse -Filter java.exe | Where-Object { $_.FullName -match '\\bin\\java.exe$' } | Select-Object -First 1
$platform = if ($ProjectLocal) { Get-ChildItem -LiteralPath (Join-Path $tools 'platform') -Recurse -Filter android.jar | Select-Object -First 1 } else { Get-Item -LiteralPath (Join-Path $tools 'platform/android.jar') }
$aapt = Get-ChildItem -LiteralPath (Join-Path $tools 'build-tools') -Recurse -Filter aapt2.exe | Select-Object -First 1
if (-not $java -or -not $platform -or -not $aapt) { throw 'SDK/JDK layout does not match expected tools.' }
$configuration = @{ javaHome=(Split-Path -Parent (Split-Path -Parent $java.FullName)); androidJar=$platform.FullName; buildTools=(Split-Path -Parent $aapt.FullName); packages=$evidence }
$configuration | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $tools 'toolchain.json') -Encoding UTF8
if (!$ProjectLocal) { $null = Get-KioskToolchain }
& $java.FullName -version
if ($LASTEXITCODE -ne 0) { throw 'Java verification failed.' }
Write-Output 'Verified toolchain ready. Signing and provisioning require the protected per-user copy. No PATH, system installation, UAC or connected-device operation performed.'
