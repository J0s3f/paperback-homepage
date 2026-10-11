# paperback-homepage

Homepage + in-browser WASM tools for [paperback.rs](https://github.com/J0s3f/paperback.rs)
(the Rust port of PaperBack 1.10). Decoding and encoding both run the actual `paperback-rs`
library as WebAssembly — **fully client-side**, nothing is uploaded to a server — and the
WebAssembly module is only fetched when the visitor first uses either tool.

## The web app (`site/`)

The decoder and the encoder both run the actual `paperback-rs` 1.3.0 library as WebAssembly.
The module (~2.5 MB) is **not loaded at page load**: the first interaction with either tool
starts a **Web Worker** (`app/worker.js`) that loads the module, so the page itself stays tiny
and stays responsive. While the worker decodes or encodes, the page shows a progress indicator
(a bar that fills per page while decoding, a spinner with elapsed time while encoding) and is
blocked until the work is done.

- **Decode**: drop page images (every image format the browser can decode) or a PDF; the
  decoder reads them in any order, restores the file for download and shows the per-page
  quality overlay (green/yellow/orange/red), even when the file cannot be restored. Each
  chosen file can be removed again from the list with the × on its chip.
- **Names and types**: restored files keep their extension even when the format's 31-byte
  name limit has to shorten the name, and a name without an extension is saved as `.bin`
  (macOS Safari saves extensionless downloads as `.dms`, a bug of its own). The download
  carries the MIME type of common kinds (PNG, JPEG, PDF, text, …).
- **Encode**: drop any file and get printable pages back — a PDF (black and white, made for
  printing) plus one PNG per page. The default is the **modern preset** of the CLI
  (`--modern`: parity blocks, filled pages, file records with the SHA-256); `balanced` and
  `legacy` (exactly PaperBack 1.10) are also selectable, along with paper size, compression
  and an optional password. Two sliders tune the error correction: PaperBack's recovery-block
  **redundancy** (off, or one block per 2–10 data blocks — the slider goes right for stronger
  protection; hidden on the modern preset, which has none) and **parity** blocks per 100 data
  blocks (hidden on legacy, which the original program cannot read). The browser caps encoding
  at 150 MB per file.
- **Printer presets and margins**: the printer preset defaults to **inkjet** (300/150 dpi,
  dots 80 %); **laser** (600/300 dpi, dots 70 %) and **camera-readable** (150/75 dpi,
  dots 80 %) are one click away, and printer resolution, dot density and dot size can be set
  by hand. The inkjet preset wants a scan at about 600 dpi (2 px per dot does not survive a
  scan, per the library's own real-world case); the camera preset's coarse 0.34 mm grid works
  with any 12 MP phone when the sheet fills the frame. Every page carries a print-safe
  **12.7 mm (0.5 in)** white margin on every side, so printing the PDF or PNG at 100 % keeps
  every dot inside the printable area.

## Repository layout

| Path | What it is |
|---|---|
| `site/` | Deployed document root: `index.html`, `style.css`, `app/app.js` |
| `site/pkg/` | Committed wasm-bindgen output (`paperback_web.js`, `paperback_web_bg.wasm`, `.d.ts`) — regenerated via `scripts/build-wasm.ps1` |
| `site/samples/` | Committed demo pages (`paperback-demo.txt`, `sample-page.png`, `sample-page.jpg`, `sample-damaged.png`) — regenerated via `web/tools/make-samples` |
| `web/` | Cargo workspace for the WASM binding (`web/paperback-web`) |
| `web/tools/make-samples` | Standalone host crate that generates `site/samples/` |
| `scripts/` | `setup-toolchain.ps1`, `build-wasm.ps1`, `serve.ps1` |

## Quick start

```powershell
.\scripts\setup-toolchain.ps1   # wasm target + wasm-bindgen-cli 0.2.129
.\scripts\build-wasm.ps1        # cargo build -> wasm-bindgen -> site/pkg
.\scripts\serve.ps1             # http://127.0.0.1:8765/
```

## Regenerating samples

```powershell
cargo run --release --manifest-path web/tools/make-samples/Cargo.toml
```

This rewrites `site/samples/` (clean PNG, JPEG re-encode, damaged PNG, demo text).
The tool self-checks by decoding the clean page back to the demo text.

## Running the acceptance checks (§10 of the plan)

1. Serve the site: `.\scripts\serve.ps1` → open `http://127.0.0.1:8765/`.
2. No console errors; `#decoder-status` shows the library version (1.3.0).
3. Load `samples/sample-page.png` → Decode → file restores, download matches `paperback-demo.txt`, overlay mostly green.
4. Load `samples/sample-damaged.png` → overlay shows yellow/orange/red blocks, file still restores, recovered blocks > 0.
5. Load `samples/sample-page.jpg` → same result as PNG.
6. Clear → state resets; multi-select two pages of one backup → single restore.
7. Lazy loading: on a fresh page load, the network shows no request for `pkg/paperback_web*`;
   the first click/drop fetches the glue and the wasm.
8. Encode: drop a text file, encode with the modern preset, download the PDF and the page
   PNGs; feed a page PNG back into the decoder — the restored bytes must match the source.
   An encrypted encode/decode round trip must work with the password and fail clearly without.
9. Progress: while the decoder or encoder works, the page is blocked and shows a progress
   indicator (bar per page when decoding, spinner with elapsed time when encoding), and is
   interactive again afterwards.
10. Printer presets: laser fills 600/300/70, camera-readable 300/100/80; a page encoded at
    300 dpi is an A4 sheet (2481×3507 px) whose ink stays 12.7 mm from every edge.

## Built artifacts

`site/pkg/*` (WASM binding output) and `site/samples/*` (demo pages) are **committed** so any
static host can deploy `site/` as-is. Regenerate them with `scripts/build-wasm.ps1` and
`web/tools/make-samples` respectively; do not hand-edit them.

## Deployment

Build the upload-ready folder and upload its contents:

```powershell
.\scripts\build-dist.ps1     # dist/: minified JS/CSS/HTML + wasm-opt -Oz
```

`dist/` is what goes on the web host (serve it as the document root for
`paperback.j0s.at`). It leaves out the TypeScript declarations and contains:

| File | Size (typical) |
|---|---|
| `pkg/paperback_web_bg.wasm` | ~2.0 MB (wasm-opt `-Oz`, down from ~2.5 MB) |
| `pkg/paperback_web.js` | ~7 KB minified glue |
| `app/app.js` | ~15 KB minified |
| `index.html`, `style.css` | ~10 KB / ~7 KB minified |
| `samples/*` | the demo pages, unchanged |

The script needs Node.js (`npx` fetches esbuild and html-minifier-terser) and wasm-opt
(downloaded to `~/.local/paperback-tools` if missing). `dist/` is a build artifact and is
not committed; the readable source stays in `site/`.

## Licence / credits

GPL-3.0-or-later. See [`NOTICE.md`](NOTICE.md) for upstream credits (PaperBack by Oleh Yuschuk,
PaperBack 1.10 changes by Michael Mohr, Reed-Solomon by Phil Karn) and this repository's note.
