param([string]$Node = 'C:\Program Files\nodejs\node.exe')
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'protect-runtime.ps1')
$tools = Get-KioskToolchain
$classes = Join-Path $root 'build/test-classes'
New-Item -ItemType Directory -Force -Path $classes | Out-Null
$source = Join-Path $root 'app/src/main/java/com/displayos/kiosk'
& (Join-Path $PSScriptRoot 'setup-test-json.ps1')
$jsonSources = @(Get-ChildItem -LiteralPath (Join-Path $root '.tools/android-json') -Filter '*.java' | ForEach-Object FullName)
& (Join-Path $tools.javaHome 'bin/javac.exe') '-encoding' 'UTF-8' '-d' $classes $jsonSources (Join-Path $source 'Protocol.java') (Join-Path $source 'SignatureCodec.java') (Join-Path $source 'NativeHttp.java') (Join-Path $source 'EnrollmentPolicy.java') (Join-Path $source 'ClaimPolicy.java') (Join-Path $source 'CapturePolicy.java') (Join-Path $source 'DeviceCommandPolicy.java') (Join-Path $source 'SnapshotState.java') (Join-Path $source 'InitializationGate.java') (Join-Path $root 'test/NativeProtocolTest.java') (Join-Path $root 'test/SnapshotStateTest.java') (Join-Path $root 'test/CapturePolicyTest.java') (Join-Path $root 'test/DeviceCommandPolicyTest.java')
if ($LASTEXITCODE -ne 0) { throw 'Native test compilation failed.' }
& (Join-Path $tools.javaHome 'bin/javac.exe') '-encoding' 'UTF-8' '-classpath' $classes '-d' $classes (Join-Path $source 'LocalContent.java') (Join-Path $root 'test/LocalContentTest.java')
if ($LASTEXITCODE -ne 0) { throw 'Local content test compilation failed.' }
& (Join-Path $tools.javaHome 'bin/java.exe') '-cp' $classes 'com.displayos.kiosk.LocalContentTest'
if ($LASTEXITCODE -ne 0) { throw 'Local content regression tests failed.' }
& (Join-Path $tools.javaHome 'bin/java.exe') '-cp' $classes 'com.displayos.kiosk.NativeProtocolTest'
if ($LASTEXITCODE -ne 0) { throw 'Native protocol tests failed.' }
& (Join-Path $tools.javaHome 'bin/java.exe') '-cp' $classes 'com.displayos.kiosk.SnapshotStateTest'
if ($LASTEXITCODE -ne 0) { throw 'Android JSON snapshot regression tests failed.' }
& (Join-Path $tools.javaHome 'bin/java.exe') '-cp' $classes 'com.displayos.kiosk.CapturePolicyTest'
if ($LASTEXITCODE -ne 0) { throw 'Capture policy tests failed.' }
& (Join-Path $tools.javaHome 'bin/java.exe') '-cp' $classes 'com.displayos.kiosk.DeviceCommandPolicyTest'
if ($LASTEXITCODE -ne 0) { throw 'Device command policy tests failed.' }
& $Node '--test' (Join-Path $root 'test/bridge.test.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Adapter/static tests failed.' }
. (Join-Path $PSScriptRoot 'protect-runtime.ps1')
$runtime = Get-KioskRuntime; Assert-KioskPrivate $runtime
$rejected = $false
try { Assert-KioskPrivate (Join-Path $root 'build') } catch { $rejected = $true }
if (!$rejected) { throw 'Expected shared workspace/runtime separation for this Windows fixture.' }
Write-Output 'Windows runtime boundary: 2 checks passed (private NTFS runtime accepted, shared exFAT workspace refused).'
& (Join-Path $root 'test/install-boundary.test.ps1')
