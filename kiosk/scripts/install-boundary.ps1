function Invoke-KioskCaptured([string]$Program, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; $output = & $Program @Arguments 2>&1; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
  return @{ Code=$code;Text=($output | ForEach-Object { $_.ToString() }) -join "`n" }
}
function Get-KioskSignerDigest($Tools, [string]$Runtime) {
  $store = Join-Path $Runtime 'demo-signing.jks'; $password = Join-Path $Runtime 'signing-password.txt'
  Assert-KioskPrivate $store; Assert-KioskPrivate $password
  $certificate = Invoke-KioskCaptured (Join-Path $Tools.javaHome 'bin/keytool.exe') @('-exportcert','-rfc','-keystore',$store,'-alias','displayos-demo','-storepass:file',$password)
  if ($certificate.Code -ne 0) { throw 'Cannot read protected signing certificate.' }
  $blocks = [regex]::Matches($certificate.Text, '-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----')
  if ($blocks.Count -ne 1) { throw 'Protected signing certificate is ambiguous.' }
  $encoded = $blocks[0].Groups[1].Value -replace '\s',''
  $bytes = [Convert]::FromBase64String($encoded)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLower() } finally { $hash.Dispose() }
}
function Assert-KioskApkSigner([string]$Apk, $Tools, [string]$Runtime) {
  $expected = Get-KioskSignerDigest $Tools $Runtime
  $result = Invoke-KioskCaptured (Join-Path $Tools.javaHome 'bin/java.exe') @('-jar',(Join-Path $Tools.buildTools 'lib/apksigner.jar'),'verify','--verbose','--print-certs',$Apk)
  if ($result.Code -ne 0) { throw 'APK cryptographic signature verification failed.' }
  $matches = [regex]::Matches($result.Text, 'Signer #(\d+) certificate SHA-256 digest: ([a-fA-F0-9]{64})')
  if ($matches.Count -ne 1 -or $matches[0].Groups[1].Value -ne '1' -or $matches[0].Groups[2].Value.ToLower() -ne $expected) { throw 'APK signer differs from the protected local signing certificate. Editable workspace evidence is not signing authority.' }
  return $expected
}
function New-KioskInstallCopy([string]$Apk, [string]$ExpectedHash, $Tools, [string]$Runtime) {
  $private = Join-Path $Runtime ('install-' + [Guid]::NewGuid().ToString('N') + '.apk')
  try {
    Copy-Item -LiteralPath $Apk -Destination $private
    Assert-KioskPrivate $private
    if ((Get-FileHash -LiteralPath $private -Algorithm SHA256).Hash.ToLower() -ne $ExpectedHash.ToLower()) { throw 'Staged APK content differs from build evidence.' }
    $digest = Assert-KioskApkSigner $private $Tools $Runtime
    Write-Output "Verified APK signer SHA256: $digest" | Write-Host
    return $private
  } catch { if (Test-Path -LiteralPath $private) { Remove-Item -LiteralPath $private -Force }; throw }
}
