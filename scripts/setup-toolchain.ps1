#Requires -Version 5.1
<#
.SYNOPSIS
  Install the pinned WASM toolchain (idempotent).
#>
$ErrorActionPreference = 'Stop'
$version = '0.2.129'

Write-Host 'Adding wasm32-unknown-unknown target...'
rustup target add wasm32-unknown-unknown

Write-Host "Installing wasm-bindgen-cli $version ..."
$installed = $false
try {
  $v = wasm-bindgen --version 2>$null
  if ($v -match [regex]::Escape($version)) {
    Write-Host "wasm-bindgen-cli $version already installed ($v). Nothing to do."
    $installed = $true
  } else {
    Write-Host "Found: $v — (re)installing $version."
  }
} catch {
  Write-Host 'wasm-bindgen CLI not found — installing.'
}

if (-not $installed) {
  try {
    cargo binstall -y "wasm-bindgen-cli@$version"
  } catch {
    Write-Host 'cargo binstall failed, falling back to cargo install...'
    cargo install "wasm-bindgen-cli" --version $version
  }
}
Write-Host 'Toolchain ready.'
