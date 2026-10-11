#Requires -Version 5.1
<#
.SYNOPSIS
  Serve the site locally for testing.
#>
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $repo 'site'
if (-not (Test-Path $dir)) { throw "Site directory not found: $dir" }
Write-Host "Serving $dir at http://127.0.0.1:8765/ (Ctrl+C to stop)"
python -m http.server 8765 --directory $dir
