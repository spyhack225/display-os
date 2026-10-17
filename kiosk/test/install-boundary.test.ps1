$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $root 'scripts/protect-runtime.ps1')
. (Join-Path $root 'scripts/install-boundary.ps1')
$runtime = Get-KioskRuntime; $tools = Get-KioskToolchain
$java = Join-Path $tools.javaHome 'bin/java.exe'; $signer = Join-Path $tools.buildTools 'lib/apksigner.jar'
$apk = Join-Path $root 'build/debug/displayos-kiosk.apk'; $hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLower()
$guid = [Guid]::NewGuid().ToString('N')
$password = Join-Path $runtime "test-password-$guid.txt"; $store = Join-Path $runtime "test-signer-$guid.p12"
$other = Join-Path $root 'build/test-other-signer.apk'; $corrupt = Join-Path $root 'build/test-corrupt.apk'
$private = $null
try {
  $private = New-KioskInstallCopy $apk $hash $tools $runtime
  if (![IO.Path]::GetFullPath($private).StartsWith($runtime + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Install copy was not private.' }
  Assert-KioskPrivate $private
  Write-Output 'PASS accepted signer and private staged copy'
  $random = New-Object byte[] 32; $generator = [Security.Cryptography.RandomNumberGenerator]::Create(); $generator.GetBytes($random); $generator.Dispose()
  [IO.File]::WriteAllText($password, [Convert]::ToBase64String($random), [Text.UTF8Encoding]::new($false)); Assert-KioskPrivate $password
  $result = Invoke-KioskCaptured (Join-Path $tools.javaHome 'bin/keytool.exe') @('-genkeypair','-keystore',$store,'-storetype','PKCS12','-storepass:file',$password,'-alias','other-test','-keyalg','RSA','-keysize','2048','-validity','1','-dname','CN=Untrusted Test Signer','-noprompt')
  if ($result.Code -ne 0) { throw 'Test signer generation failed.' }; Assert-KioskPrivate $store
  $result = Invoke-KioskCaptured $java @('-jar',$signer,'sign','--ks',$store,'--ks-key-alias','other-test','--ks-pass',"file:$password",'--out',$other,(Join-Path $root 'build/debug/aligned.apk'))
  if ($result.Code -ne 0) { throw 'Wrong-signer fixture signing failed.' }
  $rejected = $false
  try { $unexpected = New-KioskInstallCopy $other (Get-FileHash -LiteralPath $other -Algorithm SHA256).Hash $tools $runtime } catch { $rejected = $_.Exception.Message -match 'signer differs' }
  if (!$rejected) { throw 'Valid wrong signer was not rejected when attacker-controlled evidence hash matched.' }
  Write-Output 'PASS wrong signer rejected despite matching attacker-editable evidence hash'
  [IO.File]::WriteAllBytes($corrupt, [Text.Encoding]::UTF8.GetBytes('not-a-signed-apk'))
  $rejected = $false
  try { $unexpected = New-KioskInstallCopy $corrupt (Get-FileHash -LiteralPath $corrupt -Algorithm SHA256).Hash $tools $runtime } catch { $rejected = $_.Exception.Message -match 'signature verification failed' }
  if (!$rejected) { throw 'Unsigned payload was not rejected.' }
  Write-Output 'PASS unsigned payload rejected despite matching editable evidence hash'
  if ((Get-FileHash -LiteralPath $private -Algorithm SHA256).Hash.ToLower() -ne $hash) { throw 'Private install copy changed.' }
  Write-Output 'PASS verified private install copy remains bound to original signed bytes'
  Write-Output 'Installer boundary: 4 checks passed. No ADB or tablet operation performed.'
} finally {
  foreach ($path in @($password,$store,$private,$other,$corrupt)) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      $absolute = [IO.Path]::GetFullPath($path)
      if (!$absolute.StartsWith($runtime + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -and !$absolute.StartsWith((Join-Path $root 'build') + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture cleanup escapes private runtime or kiosk build.' }
      Remove-Item -LiteralPath $absolute -Force
    }
  }
}
