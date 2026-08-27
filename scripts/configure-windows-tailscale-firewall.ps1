# Run this script from an elevated PowerShell prompt.
[CmdletBinding()]
param(
  [string]$ProgramPath = "$env:LOCALAPPDATA\Leafy\leafy-financas.exe"
)

$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Administrator privileges are required to update Windows Firewall.'
}

$resolvedProgram = (Resolve-Path -LiteralPath $ProgramPath -ErrorAction Stop).Path
if ([IO.Path]::GetFileName($resolvedProgram) -ine 'leafy-financas.exe') {
  throw 'Refusing to change firewall rules for a program other than leafy-financas.exe.'
}

$blockedRules = Get-NetFirewallRule -Direction Inbound -Action Block -ErrorAction Stop | Where-Object {
  $application = $_ | Get-NetFirewallApplicationFilter
  $port = $_ | Get-NetFirewallPortFilter
  $application.Program -ieq $resolvedProgram -and $port.Protocol -eq 'TCP'
}
$blockedRules | Disable-NetFirewallRule | Out-Null

$ruleName = 'Leafy private Tailscale sync'
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule `
  -DisplayName $ruleName `
  -Description 'Allows the Leafy desktop sync server only between Tailscale IPv4 addresses.' `
  -Direction Inbound `
  -Action Allow `
  -Enabled True `
  -Profile Private `
  -Program $resolvedProgram `
  -Protocol TCP `
  -LocalAddress '100.64.0.0/10' `
  -RemoteAddress '100.64.0.0/10' | Out-Null

Write-Host "Windows Firewall now allows Leafy over the private Tailscale range."
