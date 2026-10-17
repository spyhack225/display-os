param([ValidateSet('Debug','Release')][string]$Configuration = 'Debug')
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = Join-Path $root "build/$($Configuration.ToLower())"
$evidence = Get-Content -LiteralPath (Join-Path $build 'evidence.json') -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $evidence.apk -Algorithm SHA256).Hash.ToLower() -ne $evidence.sha256) { throw 'APK differs from recorded build.' }
foreach ($source in $evidence.sources) {
  $resolved = [IO.Path]::GetFullPath((Join-Path $root $source.path))
  if (!$resolved.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source evidence escapes kiosk.' }
  if ((Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLower() -ne $source.sha256) { throw 'Source changed after compilation. Rebuild the APK.' }
}
$recorded = @($evidence.sources.path)
$current = @(Get-ChildItem -LiteralPath (Join-Path $root 'app') -Recurse -File | ForEach-Object { $_.FullName.Substring($root.Length+1).Replace('\','/') })
if (Compare-Object $recorded $current) { throw 'Build source inventory differs from current app.' }
$parsed = 0
foreach ($script in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1') {
  $tokens = $null; $errors = $null; $null = [Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw "PowerShell syntax failed: $($script.Name)" }; $parsed++
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($evidence.apk)
try {
  if (!($zip.Entries.FullName -contains 'classes.dex') -or !($zip.Entries.FullName -contains 'assets/kiosk-native-transport.js')) { throw 'APK payload missing.' }
  foreach ($entry in $zip.Entries) { if ($entry.FullName -match 'private-key|signing-password|preparation\.json|\.jks$|\.keystore$') { throw 'Private preparation material bundled in APK.' } }
} finally { $zip.Dispose() }
Write-Output "Artifact/source binding accepted; $($evidence.sources.Count) app files checked; $parsed PowerShell scripts parse; APK payload/private-file boundary accepted."
Write-Output "APK SHA256: $($evidence.sha256)"
Write-Output "App source SHA256: $($evidence.sourceSha256)"
