$ErrorActionPreference = 'Stop'
$cache = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))) '.tools/android-json'
$blobs = @{
  'JSON.java' = '1b32e698d010458b1797d96b85cc020b183fc3bc'
  'JSONArray.java' = '996f44909f5858a4d36de74ab559dd4bdc4d00f4'
  'JSONException.java' = '05e1dddc9aa4666dc89175d144288f9d9aa08ce4'
  'JSONObject.java' = '7902389794a4b5e336f50936909e5dc6d17c8cf6'
  'JSONStringer.java' = 'dd3b2a7d83f007a53039e80a3e570581317a1c1e'
  'JSONTokener.java' = '8caecc8a164b7c1ce971453f6482ab10a142e565'
}
function Assert-AndroidJsonBlob([byte[]]$Bytes, [string]$Expected) {
  $prefix = [Text.Encoding]::ASCII.GetBytes("blob $($Bytes.Length)`0")
  $payload = New-Object byte[] ($prefix.Length + $Bytes.Length)
  [Array]::Copy($prefix, 0, $payload, 0, $prefix.Length)
  [Array]::Copy($Bytes, 0, $payload, $prefix.Length, $Bytes.Length)
  $digest = [Security.Cryptography.SHA1]::Create()
  try { $actual = [BitConverter]::ToString($digest.ComputeHash($payload)).Replace('-', '').ToLower() } finally { $digest.Dispose() }
  if ($actual -ne $Expected) { throw 'Android JSON source does not match the pinned AOSP Git blob.' }
}
New-Item -ItemType Directory -Force -Path $cache | Out-Null
foreach ($name in $blobs.Keys) {
  $path = Join-Path $cache $name
  if (Test-Path -LiteralPath $path) { $bytes = [IO.File]::ReadAllBytes($path) }
  else {
    $uri = "https://android.googlesource.com/platform/libcore/+/android-8.1.0_r1/json/src/main/java/org/json/$($name)?format=TEXT"
    $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 15
    $bytes = [Convert]::FromBase64String($response.Content)
  }
  Assert-AndroidJsonBlob $bytes $blobs[$name]
  [IO.File]::WriteAllBytes($path, $bytes)
}
Write-Output 'Six unmodified Android 8.1 JSON sources verified against pinned official AOSP Git blob IDs. Test-only, Apache-2.0 source headers retained; no APK dependency added.'
