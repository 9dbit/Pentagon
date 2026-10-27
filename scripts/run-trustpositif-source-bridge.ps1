# Pentagon's signed source-relay runner for TRADEVICEPC.
# Protected credential is Windows-DPAPI-encrypted for the current user.
# Nothing in this script prints or persists the plaintext bearer token.
$ErrorActionPreference = "Stop"
$tokenFile = Join-Path $env:LOCALAPPDATA "Pentagon\TrustPositifBridge\source-bridge-credential.xml"
$scanner = Join-Path $PSScriptRoot "trustpositif-source-bridge.py"

if (!(Test-Path $tokenFile)) { throw "Pentagon registry bridge credential not provisioned" }
if (!(Test-Path $scanner)) { throw "Pentagon registry source scanner missing" }
$credential = Import-Clixml -Path $tokenFile
$token = $credential.GetNetworkCredential().Password
if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 48) {
  throw "Pentagon registry bridge credential invalid"
}
try {
  $env:PENTAGON_TP_BRIDGE_TOKEN = $token
  $env:PENTAGON_TP_BRIDGE_BASE = "https://pentagon.quest"
  & python $scanner
  if ($LASTEXITCODE -ne 0) { throw "Pentagon registry source scanner exit $LASTEXITCODE" }
} finally {
  Remove-Item Env:PENTAGON_TP_BRIDGE_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:PENTAGON_TP_BRIDGE_BASE -ErrorAction SilentlyContinue
  $token = $null
}
