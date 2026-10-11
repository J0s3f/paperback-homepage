# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Josef H.B. Schneider

<#
.SYNOPSIS
    Builds the wasm decoder and writes the wasm-bindgen output into site/pkg.

.DESCRIPTION
    The single entry point for the WebAssembly artifacts of the site.

        cd web
        cargo build --release --target wasm32-unknown-unknown -p paperback-web
        wasm-bindgen --target web --out-dir ../site/pkg --out-name paperback_web \
            target/wasm32-unknown-unknown/release/paperback_web.wasm

    The output (paperback_web.js, paperback_web_bg.wasm, paperback_web.d.ts) is what
    site/app/app.js imports, and is committed so that the site can be deployed as it is.

.PARAMETER Target
    The Rust target to build for. Defaults to wasm32-unknown-unknown; another one is only
    useful when wasm-bindgen is not run afterwards.

.EXAMPLE
    pwsh scripts/build-wasm.ps1
#>

[CmdletBinding()]
param(
    [string]$Target = 'wasm32-unknown-unknown'
)

$ErrorActionPreference = 'Stop'

# The repository, wherever this script was started from.
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$web = Join-Path $root 'web'
$outDir = Join-Path $root 'site/pkg'
$wasm = Join-Path $web "target/$Target/release/paperback_web.wasm"

function Invoke-Step {
    param(
        [string]$What,
        [scriptblock]$Action
    )
    Write-Host "==> $What" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$What failed (exit code $LASTEXITCODE)."
    }
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "cargo was not found on PATH. Install Rust (https://rustup.rs) and run scripts/setup-toolchain.ps1."
}

if (-not (Get-Command wasm-bindgen -ErrorAction SilentlyContinue)) {
    throw "wasm-bindgen was not found on PATH. Run scripts/setup-toolchain.ps1, or: cargo binstall -y wasm-bindgen-cli@0.2.129 (it must be 0.2.129, matching the wasm-bindgen the crate is pinned to)."
}

Push-Location $web
try {
    Invoke-Step "cargo build --release --target $Target -p paperback-web" {
        cargo build --release --target $Target -p paperback-web
    }

    if (-not (Test-Path $wasm)) {
        throw "The build left no $wasm behind."
    }

    # Stale artifacts of an older build would shadow the new ones in the browser cache.
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    Get-ChildItem -Path $outDir -Filter 'paperback_web*' -File -ErrorAction SilentlyContinue |
        Remove-Item -Force

    Invoke-Step "wasm-bindgen --target web --out-dir $outDir --out-name paperback_web $wasm" {
        wasm-bindgen --target web --out-dir $outDir --out-name paperback_web $wasm
    }
}
finally {
    Pop-Location
}

$artifacts = Get-ChildItem -Path $outDir -File | Sort-Object Name
if (-not $artifacts) {
    throw "wasm-bindgen wrote nothing into $outDir."
}
Write-Host "==> $outDir" -ForegroundColor Green
$artifacts | ForEach-Object {
    '{0,-28} {1,10:N0} bytes' -f $_.Name, $_.Length | Write-Host
}
