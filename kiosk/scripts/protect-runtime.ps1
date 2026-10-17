function Get-KioskRuntime {
  $ErrorActionPreference = 'Stop'
  $runtime = Join-Path $env:LOCALAPPDATA 'DisplayOSKiosk'
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  if ((Get-Item -LiteralPath $runtime).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime link refused.' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & "$env:SystemRoot\System32\icacls.exe" $runtime '/inheritance:r' '/grant:r' "*$($sid):(OI)(CI)F" '/Q' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot protect signing runtime.' }
  Assert-KioskPrivate $runtime
  foreach ($item in Get-ChildItem -LiteralPath $runtime -Force) {
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected runtime content.' }
    Assert-KioskPrivate $item.FullName
  }
  return $runtime
}
function Assert-KioskPrivate([string]$Path) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $item = Get-Item -LiteralPath $Path
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private file link refused.' }
  $acl = Get-Acl -LiteralPath $Path
  if ($item.PSIsContainer -and -not $acl.AreAccessRulesProtected) { throw 'Private directory inheritance remains enabled.' }
  $rules = $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
  if ($rules.Count -eq 0) { throw 'No enforceable private ACL.' }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne 'Allow') { throw 'Signing/provisioning data is accessible to another principal.' }
  }
}
function Get-KioskToolchain {
  $directory = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'DisplayOSKioskToolchain'))
  Assert-KioskPrivate $directory
  $tools = Get-Content -LiteralPath (Join-Path $directory 'toolchain.json') -Raw | ConvertFrom-Json
  foreach ($path in @($tools.javaHome,$tools.buildTools,$tools.androidJar)) {
    if (![IO.Path]::GetFullPath($path).StartsWith($directory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Toolchain configuration escapes protected root.' }
  }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $items = @(Get-ChildItem -LiteralPath $tools.javaHome,$tools.buildTools -Recurse -Force) + @(Get-Item -LiteralPath $tools.javaHome,$tools.buildTools,$tools.androidJar,(Join-Path $directory 'toolchain.json'))
  foreach ($item in $items) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Toolchain link refused.' }
    $rules = (Get-Acl -LiteralPath $item.FullName).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    if ($rules.Count -eq 0) { throw 'Toolchain ACL absent.' }
    foreach ($rule in $rules) { if ($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne 'Allow') { throw 'Executable toolchain accessible to another principal.' } }
  }
  return $tools
}
