param([ValidateSet('Debug','Release')][string]$Configuration = 'Debug', [string]$Origin = $env:DISPLAYOS_ORIGIN, [string]$SigningStore, [string]$SigningAlias = 'displayos-demo')
$ErrorActionPreference = 'Stop'
if (-not $Origin) { throw 'Set DISPLAYOS_ORIGIN or pass -Origin with the HTTPS origin of your deployment.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'protect-runtime.ps1')
$runtime = Get-KioskRuntime
$tools = Get-KioskToolchain
$java = Join-Path $tools.javaHome 'bin/java.exe'
$javac = Join-Path $tools.javaHome 'bin/javac.exe'
$keytool = Join-Path $tools.javaHome 'bin/keytool.exe'
if ($Origin -notmatch '^https://[a-z0-9.-]+$') { throw 'Canonical HTTPS origin required.' }
$build = Join-Path $root "build/$($Configuration.ToLower())"
$classes = Join-Path $build 'classes'
$generated = Join-Path $build 'generated/com/displayos/kiosk'
foreach ($target in @($classes,(Join-Path $build 'generated'),(Join-Path $build 'dex'))) {
  $resolved = [IO.Path]::GetFullPath($target)
  if (!$resolved.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Build cleanup escapes kiosk tree.' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
New-Item -ItemType Directory -Force -Path $classes,$generated | Out-Null
function Invoke-Checked([string]$Program, [string[]]$Arguments) { & $Program @Arguments; if ($LASTEXITCODE -ne 0) { throw "Tool failed: $([IO.Path]::GetFileName($Program))" } }
$debug = ($Configuration -eq 'Debug').ToString().ToLower()
$manifest = (Get-Content -LiteralPath (Join-Path $root 'app/src/main/AndroidManifest.xml') -Raw).Replace('${debuggable}', $debug)
$manifestPath = Join-Path $build 'AndroidManifest.xml'
[IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $generated 'BuildConfig.java'), "package com.displayos.kiosk; public final class BuildConfig { public static final boolean DEBUG = $debug; public static final String ORIGIN = `"$Origin`"; }", [Text.UTF8Encoding]::new($false))
$resources = Join-Path $build 'resources.zip'
$unsigned = Join-Path $build 'unsigned.apk'
Invoke-Checked (Join-Path $tools.buildTools 'aapt2.exe') @('compile','--dir',(Join-Path $root 'app/src/main/res'),'-o',$resources)
Invoke-Checked (Join-Path $tools.buildTools 'aapt2.exe') @('link','-o',$unsigned,'-I',$tools.androidJar,'--manifest',$manifestPath,'--java',(Join-Path $build 'generated'),'-A',(Join-Path $root 'app/src/main/assets'),'--min-sdk-version','26','--target-sdk-version','35','--version-code','1','--version-name','0.1.0',$resources)
$sources = @((Get-ChildItem -Path (Join-Path $root 'app/src/main/java'),(Join-Path $build 'generated') -Recurse -Filter '*.java').FullName)
Invoke-Checked $javac (@('-encoding','UTF-8','--release','8','-classpath',$tools.androidJar,'-d',$classes) + $sources)
$classJar = Join-Path $build 'classes.jar'
Invoke-Checked (Join-Path $tools.javaHome 'bin/jar.exe') @('cf',$classJar,'-C',$classes,'.')
$dex = Join-Path $build 'dex'; New-Item -ItemType Directory -Force -Path $dex | Out-Null
Invoke-Checked $java @('-cp',(Join-Path $tools.buildTools 'lib/d8.jar'),'com.android.tools.r8.D8','--min-api','26','--lib',$tools.androidJar,'--output',$dex,$classJar)
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$archive = [IO.Compression.ZipFile]::Open($unsigned, [IO.Compression.ZipArchiveMode]::Update)
try { foreach ($file in Get-ChildItem -LiteralPath $dex -Filter '*.dex') { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $file.Name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null } } finally { $archive.Dispose() }
$passwordFile = Join-Path $runtime 'signing-password.txt'
if ($Configuration -eq 'Debug') {
  $SigningStore = Join-Path $runtime 'demo-signing.jks'
  if (!(Test-Path -LiteralPath $passwordFile)) {
    $random = New-Object byte[] 32; $generator = [Security.Cryptography.RandomNumberGenerator]::Create(); $generator.GetBytes($random); $generator.Dispose()
    [IO.File]::WriteAllText($passwordFile, [Convert]::ToBase64String($random), [Text.UTF8Encoding]::new($false))
  }
  Assert-KioskPrivate $passwordFile
  if (!(Test-Path -LiteralPath $SigningStore)) { Invoke-Checked $keytool @('-genkeypair','-keystore',$SigningStore,'-storepass:file',$passwordFile,'-keypass:file',$passwordFile,'-storetype','JKS','-alias',$SigningAlias,'-keyalg','RSA','-keysize','3072','-validity','3650','-dname','CN=DisplayOS Local Demo','-noprompt') }
} else {
  if (!$SigningStore -or !(Test-Path -LiteralPath $passwordFile)) { throw 'Release requires an existing privately ACL-protected signing store and runtime/signing-password.txt. Commercial signing is an owner decision.' }
}
Assert-KioskPrivate $SigningStore
$aligned = Join-Path $build 'aligned.apk'; $apk = Join-Path $build 'displayos-kiosk.apk'
Invoke-Checked (Join-Path $tools.buildTools 'zipalign.exe') @('-f','-p','4',$unsigned,$aligned)
Invoke-Checked $java @('-jar',(Join-Path $tools.buildTools 'lib/apksigner.jar'),'sign','--ks',$SigningStore,'--ks-key-alias',$SigningAlias,'--ks-pass',"file:$passwordFile",'--out',$apk,$aligned)
Invoke-Checked $java @('-jar',(Join-Path $tools.buildTools 'lib/apksigner.jar'),'verify','--verbose','--print-certs',$apk)
Invoke-Checked (Join-Path $tools.buildTools 'aapt2.exe') @('dump','badging',$apk)
$sourceHashes = @(Get-ChildItem -LiteralPath (Join-Path $root 'app') -Recurse -File | Sort-Object FullName | ForEach-Object { @{path=$_.FullName.Substring($root.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()} })
$hashInput = ($sourceHashes | ForEach-Object { $_.path + '=' + $_.sha256 }) -join "`n"
$hasher = [Security.Cryptography.SHA256]::Create(); $sourceHash = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($hashInput)))).Replace('-','').ToLower(); $hasher.Dispose()
$evidence = [ordered]@{ apk=$apk;sha256=(Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLower();sourceSha256=$sourceHash;sources=$sourceHashes;toolchain=$tools.packages;configuration=$Configuration;origin=$Origin;builtAt=[DateTime]::UtcNow.ToString('o');installed=$false;hardwareTested=$false }
$evidence | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $build 'evidence.json') -Encoding UTF8
Write-Output "Built and verified $apk"
