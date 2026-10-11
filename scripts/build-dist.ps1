# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Josef H.B. Schneider

<#
.SYNOPSIS
    Builds the upload-ready dist/ folder: the site, minified, with an optimized wasm.

.DESCRIPTION
    Copies site/ into dist/ (the TypeScript declaration files are left out — the browser
    does not need them), minifies the JavaScript and CSS with esbuild and the HTML with
    html-minifier-terser (both through npx), and shrinks the WebAssembly with wasm-opt
    (-Oz, about 20 % smaller). Upload the contents of dist/ to the web host; site/ stays
    the readable source.

    Tools: Node.js (npx) for the minifiers. wasm-opt is looked up on PATH and under
    ~/.local/paperback-tools/binaryen-*/bin; if it is missing it is downloaded there
    (binaryen version 133).

.EXAMPLE
    pwsh scripts/build-dist.ps1
#>

[CmdletBinding()]
param(
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$site = Join-Path $root 'site'
$dist = if ($OutDir) { [System.IO.Path]::GetFullPath($OutDir) } else { Join-Path $root 'dist' }

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    throw 'npx was not found on PATH. Install Node.js (https://nodejs.org) to minify the files.'
}

function Invoke-Step {
    param([string]$What, [scriptblock]$Action)
    Write-Host "==> $What" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)." }
}

# --- 1. copy site/ to dist/, without the declaration files -------------------
if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
foreach ($dir in 'app', 'pkg', 'samples') {
    New-Item -ItemType Directory -Force -Path (Join-Path $dist $dir) | Out-Null
}
Copy-Item (Join-Path $site 'index.html') $dist
Copy-Item (Join-Path $site 'style.css') $dist
Copy-Item (Join-Path $site 'app/*') (Join-Path $dist 'app')
Copy-Item (Join-Path $site 'pkg/paperback_web.js') (Join-Path $dist 'pkg')
Copy-Item (Join-Path $site 'pkg/paperback_web_bg.wasm') (Join-Path $dist 'pkg')
Copy-Item (Join-Path $site 'samples/*') (Join-Path $dist 'samples')

# --- 2. minify the JavaScript and the CSS ------------------------------------
foreach ($file in 'app/app.js', 'app/worker.js', 'pkg/paperback_web.js', 'style.css') {
    $path = Join-Path $dist $file
    Invoke-Step "esbuild --minify $file" {
        npx --yes esbuild $path --minify "--outfile=$path.tmp"
    }
    Move-Item -Force "$path.tmp" $path
}

# --- 3. minify the HTML ------------------------------------------------------
$html = Join-Path $dist 'index.html'
Invoke-Step 'html-minifier-terser index.html' {
    npx --yes html-minifier-terser --collapse-whitespace --remove-comments `
        --remove-redundant-attributes --remove-empty-attributes --minify-css --minify-js `
        --output "$html.tmp" $html
}
Move-Item -Force "$html.tmp" $html

# --- 4. shrink the WebAssembly ----------------------------------------------
function Find-WasmOpt {
    $command = Get-Command wasm-opt -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $tools = Join-Path $env:USERPROFILE '.local/paperback-tools'
    $found = Get-ChildItem -Path $tools -Filter 'wasm-opt.exe' -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) { return $found.FullName }
    return $null
}

$wasmOpt = Find-WasmOpt
if (-not $wasmOpt) {
    $tools = Join-Path $env:USERPROFILE '.local/paperback-tools'
    $version = 'version_133'
    Write-Host "==> downloading binaryen $version" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $tools | Out-Null
    $archive = Join-Path $tools 'binaryen.tar.gz'
    Invoke-WebRequest -UseBasicParsing -Uri `
        "https://github.com/WebAssembly/binaryen/releases/download/$version/binaryen-$version-x86_64-windows.tar.gz" `
        -OutFile $archive
    tar -xzf $archive -C $tools
    Remove-Item -Force $archive
    $wasmOpt = Find-WasmOpt
    if (-not $wasmOpt) { throw 'binaryen was downloaded but wasm-opt.exe was not found.' }
}

$wasm = Join-Path $dist 'pkg/paperback_web_bg.wasm'
Invoke-Step 'wasm-opt -Oz' {
    & $wasmOpt -Oz $wasm -o "$wasm.tmp"
}
Move-Item -Force "$wasm.tmp" $wasm

# --- 5. report ---------------------------------------------------------------
$files = Get-ChildItem -Path $dist -Recurse -File | Sort-Object FullName
$total = ($files | Measure-Object -Property Length -Sum).Sum
Write-Host "==> $dist" -ForegroundColor Green
foreach ($file in $files) {
    '{0,-44} {1,10:N0} bytes' -f $file.FullName.Substring($dist.Length + 1), $file.Length | Write-Host
}
'{0,-44} {1,10:N0} bytes' -f 'TOTAL', $total | Write-Host
