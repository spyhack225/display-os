param(
  [Parameter(Mandatory)][ValidateSet('Export','Prepare','Recover')][string]$Action,
  [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9._:-]{1,80}$')][string]$Serial,
  [string]$Adb,
  [string]$Origin = $env:DISPLAYOS_ORIGIN,
  [string]$FactorySecretsFile,
  [string]$TicketFile,
  [switch]$Install,
  [switch]$Launch
)
$ErrorActionPreference = 'Stop'
if (-not $Origin) { throw 'Set DISPLAYOS_ORIGIN or pass -Origin with the HTTPS origin of your deployment.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# Windows PowerShell 5.1 leaves $PSScriptRoot unset while binding parameter defaults for a
# script with Mandatory parameters run via -File, so the adb default is resolved in the body.
if (-not $Adb) { $Adb = Join-Path $PSScriptRoot '..\..\tools\platform-tools\adb.exe' }
. (Join-Path $PSScriptRoot 'protect-runtime.ps1')
. (Join-Path $PSScriptRoot 'install-boundary.ps1')
$runtime = Get-KioskRuntime
function Read-PrivateJson([string]$Path) {
  Assert-KioskPrivate $Path
  try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { throw 'Protected input is not valid JSON. Its contents are not displayed.' }
}
if (!(Test-Path -LiteralPath $Adb)) { throw 'Explicit trusted adb executable required. This script does not download or start USB repair tools.' }
if ($Origin -notmatch '^https://[a-z0-9.-]+$') { throw 'Canonical HTTPS origin required.' }
function Invoke-Adb([string]$Arguments, [string]$InputText) {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $Adb; $start.Arguments = "-s $Serial $Arguments"; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true; $start.RedirectStandardInput = $true
  $process = New-Object Diagnostics.Process; $process.StartInfo = $start
  if (!$process.Start()) { throw 'ADB process did not start.' }
  $outputTask = $process.StandardOutput.ReadToEndAsync(); $errorTask = $process.StandardError.ReadToEndAsync()
  if ($null -ne $InputText) { $process.StandardInput.Write($InputText) }; $process.StandardInput.Close()
  if (!$process.WaitForExit(20000)) { $process.Kill(); throw 'ADB operation timed out. No retry or USB restart attempted.' }
  $output = $outputTask.GetAwaiter().GetResult(); $null = $errorTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw 'ADB operation refused. Verify owner-authorized USB debugging, selected serial and compatible installed app.' }
  $process.Dispose(); return $output.Trim()
}
$model = Invoke-Adb 'shell getprop ro.product.model' $null
$api = Invoke-Adb 'shell getprop ro.build.version.sdk' $null
if ($model -ne 'SM-T580' -or $api -notmatch '^\d+$' -or [int]$api -lt 26) { throw 'Only owner-qualified SM-T580 with Android API 26 or newer is allowed. No firmware change or model bypass is provided.' }
if ($Install) {
  $apk = Join-Path $root 'build/debug/displayos-kiosk.apk'
  $evidence = Get-Content -LiteralPath (Join-Path $root 'build/debug/evidence.json') -Raw | ConvertFrom-Json
  if ($evidence.origin -ne $Origin -or (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLower() -ne $evidence.sha256) { throw 'Built APK origin/hash does not match this preparation.' }
  $tools = Get-KioskToolchain
  $privateApk = New-KioskInstallCopy $apk $evidence.sha256 $tools $runtime
  try { $null = Invoke-Adb "install -r `"$privateApk`"" $null } finally { Remove-Item -LiteralPath $privateApk -Force }
}
if ($Launch -or $Install -or $Action -eq 'Recover') { $null = Invoke-Adb 'shell am start -n com.displayos.kiosk/.MainActivity' $null; Start-Sleep -Seconds 2 }
$publicKeyText = Invoke-Adb 'shell run-as com.displayos.kiosk cat files/public-key.json' $null
$information = (Invoke-Adb 'shell run-as com.displayos.kiosk cat files/unit-info.json' $null) | ConvertFrom-Json
if ($information.origin -ne $Origin) { throw 'Installed native origin does not match factory destination. No credential will be sent.' }
if ($Action -eq 'Recover') {
  for ($attempt = 0; $attempt -lt 12 -and !$information.prepared; $attempt++) {
    Start-Sleep -Seconds 1
    $information = (Invoke-Adb 'shell run-as com.displayos.kiosk cat files/unit-info.json' $null) | ConvertFrom-Json
  }
  if (!$information.prepared) { throw 'Native proof recovery is not confirmed. No factory ticket was issued, key replaced or identity cloned.' }
  Write-Output 'Native encrypted enrollment is present. Any rejected bearer is recovered by native polling with the unit Keystore proof.'
  return
}
if ($Action -eq 'Prepare' -and $information.prepared) { throw 'This unit is already enrolled. Use native proof recovery or an owner reset, not another factory ticket.' }
$publicKey = $publicKeyText | ConvertFrom-Json
if ($publicKey.kty -ne 'EC' -or $publicKey.crv -ne 'P-256' -or $publicKey.x -notmatch '^[A-Za-z0-9_-]{43}$' -or $publicKey.y -notmatch '^[A-Za-z0-9_-]{43}$' -or $publicKey.PSObject.Properties.Name -contains 'd') { throw 'Native public key export is invalid. No desktop private key is accepted.' }
$safeSerial = $Serial.Replace(':','_')
$publicKeyFile = Join-Path $runtime "native-public-key-$safeSerial.json"
[IO.File]::WriteAllText($publicKeyFile, $publicKeyText, [Text.UTF8Encoding]::new($false)); Assert-KioskPrivate $publicKeyFile
Write-Output "Native public JWK exported to protected runtime: $publicKeyFile"
if ($Action -eq 'Export') { return }
if ($TicketFile) {
  $ticket = Read-PrivateJson $TicketFile
} else {
  if (!$FactorySecretsFile) { throw 'Prepare requires a protected factory secrets file or a protected ticket response issued for this native public key.' }
  $credential = (Read-PrivateJson $FactorySecretsFile).FACTORY_CREDENTIAL
  if (!$credential -or $credential -notmatch '^[A-Za-z0-9_-]{32,256}$') { throw 'Protected factory credential is missing or invalid.' }
  $body = @{ serial=$Serial;hardwareProfile='samsung-sm-t580-demo';publicKey=$publicKey } | ConvertTo-Json -Depth 5 -Compress
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$Origin/factory/v1/tickets" -Method Post -ContentType 'application/json' -Headers @{Authorization="Bearer $credential"} -Body $body -MaximumRedirection 0 -TimeoutSec 15
    $ticket = $response.Content | ConvertFrom-Json
  } catch { throw 'Factory refused the native unit ticket. No credentials or HTTP error contents are displayed. Request a new ticket if expired.' }
  finally { $credential = $null }
  $TicketFile = Join-Path $runtime "native-ticket-$safeSerial.json"
  [IO.File]::WriteAllText($TicketFile, ($ticket | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false)); Assert-KioskPrivate $TicketFile
}
if ($ticket.ticket -notmatch '^[A-Za-z0-9_-]{43}$' -or [double]$ticket.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 5000 -or !$ticket.deviceId -or $ticket.PSObject.Properties.Name -contains 'privateKey') { throw 'Factory response is expired, invalid, or contains a desktop private key. Request a new native-key-bound ticket.' }
$preparation = @{ticket=$ticket.ticket;deviceId=$ticket.deviceId} | ConvertTo-Json -Compress
try {
  $null = Invoke-Adb "shell run-as com.displayos.kiosk sh -c 'cat > files/preparation.json'" $preparation
  $result = Invoke-Adb 'shell am broadcast -n com.displayos.kiosk/.PreparationReceiver -a com.displayos.kiosk.PREPARE' $null
  if ($result -notmatch 'result=0') { throw 'Native enrollment did not report success. Verify ticket expiry and key binding; do not clone identities.' }
  Write-Output 'Fresh unclaimed native enrollment accepted. No installer PIN was requested. Owner chooses a PIN on the unit during deliberate physical home confirmation; the bearer stays encrypted inside the app.'
} finally {
  $preparation = $null; $null = Invoke-Adb 'shell run-as com.displayos.kiosk rm -f files/preparation.json' $null
}
