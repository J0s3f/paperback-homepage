// SPDX-License-Identifier: GPL-3.0-or-later
//! Generates the committed demo samples for the paperback.rs homepage.
//!
//! Run with `cargo run --release` from this crate. It writes into
//! `<repo root>/site/samples` by default, or into `--out <dir>`:
//!
//! * `paperback-demo.txt` — the source content (also the name stored on the pages)
//! * `sample-page.png`    — a clean encoded page
//! * `sample-page.jpg`    — the same page re-encoded as JPEG (browser-side JPEG path)
//! * `sample-damaged.png` — the same page with small white squares wiped from the dot field
//!
//! The output is deterministic (fixed `FileTime`) and self-verifying: every page is decoded
//! again and must restore exactly the source bytes.
//!
//! `paperback_rs::layout::PageLayout` is private in 1.3.0, so this tool cannot address
//! individual block cells. It wipes candidate squares instead and keeps the first one that
//! still decodes while the report shows blocks rebuilt from the recovery data.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use image::ImageEncoder;
use image::codecs::jpeg::JpegEncoder;
use paperback_rs::block::FileTime;
use paperback_rs::decode::{DecodeOptions, RestoredFile, decode};
use paperback_rs::encode::{EncodeOptions, Page, encode};
use paperback_rs::imageio::{read_pages, write_png};
use paperback_rs::layout::PageSetup;
use paperback_rs::raster::{Raster, WHITE};

/// Fixed modification time stored on the pages, so runs are reproducible.
const MODIFIED_UNIX_SECONDS: u64 = 1_752_000_000;
/// File name stored on the pages and written next to them.
const SAMPLE_NAME: &str = "paperback-demo.txt";
/// Candidate centres (fractions of the raster width/height) for the wiped squares.
const CANDIDATES: &[(f64, f64)] = &[
    (0.30, 0.35),
    (0.55, 0.50),
    (0.42, 0.68),
    (0.68, 0.32),
    (0.22, 0.55),
    (0.50, 0.78),
    (0.35, 0.45),
    (0.60, 0.40),
    (0.45, 0.58),
    (0.75, 0.60),
    (0.28, 0.72),
    (0.65, 0.72),
];
/// Side of a wiped square as a fraction of the raster width (~1.6%).
const WIPE_SIDE_FRACTION: f64 = 0.016;
/// The title text sits in the top/bottom bands; keep wipes out of them.
const TEXT_BAND_FRACTION: f64 = 0.15;
/// JPEG quality for `sample-page.jpg`.
const JPEG_QUALITY: u8 = 85;
/// Upper bound for the JPEG sample; the quality is lowered until it fits.
const JPEG_MAX_BYTES: usize = 1_500_000;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let out_dir = output_dir()?;
    fs::create_dir_all(&out_dir).map_err(|e| format!("cannot create {}: {e}", out_dir.display()))?;
    println!("writing samples to {}", out_dir.display());

    let source = source_text();
    let source_bytes = source.as_bytes();
    if !(10_000..=20_000).contains(&source_bytes.len()) {
        return Err(format!(
            "source content is {} bytes, wanted 10-20 KB",
            source_bytes.len()
        ));
    }

    // ---- encode the clean page -------------------------------------------------
    let options = EncodeOptions {
        setup: PageSetup {
            printer_dpi: 300,
            dot_dpi: 100,
            ..PageSetup::default()
        },
        name: SAMPLE_NAME.to_string(),
        modified: FileTime::from_unix_seconds(MODIFIED_UNIX_SECONDS),
        ..EncodeOptions::default()
    };
    let pages = encode(source_bytes, &options).map_err(|e| format!("encode failed: {e}"))?;
    if pages.len() != 1 {
        return Err(format!(
            "the source content needs {} pages; the samples expect exactly one",
            pages.len()
        ));
    }
    let clean = &pages[0];
    println!(
        "encoded page: {}x{} px",
        clean.raster.width(),
        clean.raster.height()
    );

    // ---- paperback-demo.txt ----------------------------------------------------
    let text_path = out_dir.join(SAMPLE_NAME);
    write_and_report(&text_path, source_bytes, "source content")?;

    // ---- sample-page.png (and its sanity check) --------------------------------
    let clean_png =
        write_png(clean).map_err(|e| format!("cannot render the clean page: {e}"))?;
    let clean_path = out_dir.join("sample-page.png");
    write_and_report(&clean_path, &clean_png, "clean page")?;
    let restored = decode_png(&clean_png)?;
    check_restored(&restored, source_bytes, "sample-page.png")?;
    if restored.report.recovered_blocks != 0 || restored.report.parity_recovered_blocks != 0 {
        return Err(format!(
            "the clean page reports recovered blocks ({} from recovery, {} from parity)",
            restored.report.recovered_blocks, restored.report.parity_recovered_blocks
        ));
    }
    print_decode("sample-page.png", &restored);

    // ---- sample-page.jpg (browser-side JPEG path) ------------------------------
    let (jpeg, quality) = encode_jpeg_under_limit(&clean.raster)?;
    let jpeg_path = out_dir.join("sample-page.jpg");
    write_and_report(&jpeg_path, &jpeg, "JPEG page")?;
    println!("  JPEG quality {quality}");
    let restored = decode_png(&jpeg)?;
    check_restored(&restored, source_bytes, "sample-page.jpg")?;
    print_decode("sample-page.jpg", &restored);

    // ---- sample-damaged.png (verified by decoding) -----------------------------
    let damaged = best_damage(clean, source_bytes)?;
    let damaged_path = out_dir.join("sample-damaged.png");
    write_and_report(&damaged_path, &damaged.png, "damaged page")?;
    println!("  wiped square at ({:.2}, {:.2})", damaged.at.0, damaged.at.1);
    print_decode("sample-damaged.png", &damaged.restored);
    // Extra check: with the quality map on, the wiped cells must be red (unreadable).
    let red_blocks = decode_png_quality(&damaged.png)?.1;
    if red_blocks < 1 {
        return Err("the damaged page decodes but its quality overlay shows no red blocks".into());
    }
    println!("  sample-damaged.png: overlay shows {red_blocks} unreadable (red) block(s)");

    println!("\nall samples written and verified");
    Ok(())
}

/// The output directory: `--out <dir>`, or `<repo root>/site/samples`.
fn output_dir() -> Result<PathBuf, String> {
    let mut args = std::env::args().skip(1);
    let mut out: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--out needs a directory".to_string())?;
                out = Some(PathBuf::from(value));
            }
            other => return Err(format!("unknown argument {other:?}; use --out <dir>")),
        }
    }
    if let Some(dir) = out {
        return Ok(dir);
    }
    // <repo root>/web/tools/make-samples → three parents up.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .ancestors()
        .nth(3)
        .ok_or_else(|| format!("cannot find the repository root from {}", manifest.display()))?;
    Ok(root.join("site").join("samples"))
}

/// Decodes PNG (or JPEG) bytes with the library and returns the restored file.
fn decode_png(bytes: &[u8]) -> Result<RestoredFile, String> {
    let rasters = read_pages(bytes).map_err(|e| format!("read_pages failed: {e}"))?;
    decode(
        &rasters,
        &DecodeOptions {
            threads: 1,
            ..DecodeOptions::default()
        },
        |_| {},
    )
    .map_err(|e| format!("decode failed: {e}"))
}

/// Decodes bytes and also returns the largest number of unreadable (red) blocks any page's
/// quality overlay shows, for verifying that a damaged sample really is drawn red.
fn decode_png_quality(bytes: &[u8]) -> Result<(RestoredFile, usize), String> {
    let rasters = read_pages(bytes).map_err(|e| format!("read_pages failed: {e}"))?;
    let mut worst = 0;
    let restored = decode(
        &rasters,
        &DecodeOptions {
            quality: true,
            threads: 1,
            ..DecodeOptions::default()
        },
        |outcome| {
            if let Some(quality) = outcome.quality {
                worst = worst.max(quality.unreadable_blocks());
            }
        },
    )
    .map_err(|e| format!("decode failed: {e}"))?;
    Ok((restored, worst))
}

/// Fails unless the decode restored exactly the source bytes and name.
fn check_restored(
    restored: &RestoredFile,
    source: &[u8],
    what: &str,
) -> Result<(), String> {
    if restored.data != source {
        return Err(format!(
            "{what} restored {} bytes that do not match the source ({} bytes)",
            restored.data.len(),
            source.len()
        ));
    }
    if restored.name != SAMPLE_NAME {
        return Err(format!(
            "{what} restored the name {:?}, expected {SAMPLE_NAME:?}",
            restored.name
        ));
    }
    Ok(())
}

/// A damaged page that passed the decode check.
struct Damaged {
    png: Vec<u8>,
    at: (f64, f64),
    restored: RestoredFile,
}

/// Wipes candidate squares until one decodes with blocks rebuilt from recovery.
fn best_damage(clean: &Page, source: &[u8]) -> Result<Damaged, String> {
    let width = clean.raster.width();
    let side = (WIPE_SIDE_FRACTION * width as f64).round() as usize;
    let mut failures = Vec::new();
    for &(cx, cy) in CANDIDATES {
        let raster = wipe_square(&clean.raster, cx, cy, side);
        let page = Page {
            raster,
            dpi: clean.dpi,
        };
        let png = write_png(&page).map_err(|e| format!("cannot render a damaged page: {e}"))?;
        match decode_png(&png) {
            Ok(restored) => {
                if restored.data != source {
                    failures.push(format!(
                        "({cx:.2}, {cy:.2}): restored {} bytes, wrong content",
                        restored.data.len()
                    ));
                } else if restored.report.recovered_blocks < 1 {
                    failures.push(format!(
                        "({cx:.2}, {cy:.2}): decoded but {} blocks recovered \
                         (parity rebuilt {})",
                        restored.report.recovered_blocks, restored.report.parity_recovered_blocks
                    ));
                } else {
                    return Ok(Damaged {
                        png,
                        at: (cx, cy),
                        restored,
                    });
                }
            }
            Err(e) => failures.push(format!("({cx:.2}, {cy:.2}): {e}")),
        }
    }
    Err(format!(
        "no candidate produced a recoverable damaged page; tried {}:\n  {}",
        CANDIDATES.len(),
        failures.join("\n  ")
    ))
}

/// A copy of the raster with a white square wiped at the given centre fractions,
/// clamped to the interior and away from the title bands.
fn wipe_square(raster: &Raster, cx: f64, cy: f64, side: usize) -> Raster {
    let mut damaged = raster.clone();
    let (width, height) = (raster.width(), raster.height());
    let low = (TEXT_BAND_FRACTION * height as f64) as usize;
    let high = ((1.0 - TEXT_BAND_FRACTION) * height as f64) as usize;
    let x = ((cx * width as f64) as usize)
        .saturating_sub(side / 2)
        .min(width.saturating_sub(side));
    let y = ((cy * height as f64) as usize)
        .saturating_sub(side / 2)
        .clamp(low, high.saturating_sub(side));
    damaged.fill_rect(x, y, side, side, WHITE);
    damaged
}

/// Encodes the raster as grayscale JPEG, lowering the quality until it fits the limit.
fn encode_jpeg_under_limit(raster: &Raster) -> Result<(Vec<u8>, u8), String> {
    let mut quality = JPEG_QUALITY;
    loop {
        let bytes = encode_jpeg(raster, quality)?;
        if bytes.len() <= JPEG_MAX_BYTES || quality <= 40 {
            return Ok((bytes, quality));
        }
        println!(
            "  JPEG at quality {quality} is {} bytes; lowering the quality",
            bytes.len()
        );
        quality -= 5;
    }
}

fn encode_jpeg(raster: &Raster, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut out, quality);
    encoder
        .write_image(
            raster.pixels(),
            raster.width() as u32,
            raster.height() as u32,
            image::ExtendedColorType::L8,
        )
        .map_err(|e| format!("JPEG encode failed: {e}"))?;
    Ok(out)
}

fn write_and_report(path: &Path, bytes: &[u8], what: &str) -> Result<(), String> {
    fs::write(path, bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    println!("{:<28} {:>9} bytes  ({what})", file_name(path), bytes.len());
    Ok(())
}

fn print_decode(what: &str, restored: &RestoredFile) {
    let report = &restored.report;
    println!(
        "  {what}: restored {:?}, {} bytes, pages {}, good {}, bad {}, \
         recovered {} (parity {}), misplaced {}",
        restored.name,
        restored.data.len(),
        report.pages_read,
        report.good_blocks,
        report.bad_blocks,
        report.recovered_blocks,
        report.parity_recovered_blocks,
        report.misplaced_blocks,
    );
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// The deterministic source content: a greeting, an explanation of paperback.rs and how to
/// test the web decoder, padded with numbered practice sections to reach ~13 KB.
fn source_text() -> String {
    let mut text = String::from(
        "Hello, and welcome to paperback.rs!\n\
         \n\
         You are reading the demonstration file that the sample pages on the homepage\n\
         restore. If your decoder produced exactly these bytes, everything worked: the\n\
         scanner-side reader, the error correction and the recovery blocks all did their\n\
         job. The name stored on the pages is paperback-demo.txt, and the modification\n\
         time is fixed so that every run of the sample generator produces the very same\n\
         pages.\n\
         \n\
         What is paperback.rs?\n\
         \n\
         paperback.rs is a command-line program that stores files on paper. It is a Rust\n\
         port of PaperBack 1.10, the classic data-backup program by Oleh Yuschuk. You give\n\
         it a file, it renders that file as dense grids of black and white dots on ordinary\n\
         sheets, and you print those sheets. Later, you photograph or scan the sheets and\n\
         the program reads the file back. Paper is cheap, stable and readable without any\n\
         special hardware, so a box of printed pages makes a surprisingly durable archive.\n\
         \n\
         The pages carry more than the raw payload. Each block of data has a checksum, and\n\
         the pages carry recovery blocks as well, so a smudge, a staple or a torn corner\n\
         does not have to be fatal. The reader tries several ways of sampling a block and\n\
         can rebuild a limited number of lost blocks from the recovery data. It also\n\
         prints a quality overlay that shows block by block how well a scan was read.\n\
         \n\
         Formats and compatibility\n\
         \n\
         The encoder writes PNG, BMP and PDF pages; BMP is the one format the original\n\
         PaperBack opens directly. The decoder reads PNG, JPEG and BMP images as well as\n\
         PDF documents, in any order, and it accepts scans and photographs, not just clean\n\
         renders. Pages written by this program are meant to be read by the original\n\
         program, and pages written by the original program are read back here: the two\n\
         are interoperable in both directions.\n\
         \n\
         How to test the web decoder\n\
         \n\
         The homepage runs the actual Rust library as WebAssembly in your browser. Nothing\n\
         is uploaded: your images stay on your machine. To try it, scroll to the decoder\n\
         section and do one of two things.\n\
         \n\
         First, the two sample buttons load a page that is already part of the site. The\n\
         clean sample, sample-page.png, decodes to a file that you can download as\n\
         paperback-demo.txt. Its quality overlay should be green nearly everywhere. The\n\
         damaged sample, sample-damaged.png, has small squares wiped out of the dot field;\n\
         its overlay shows those squares in red and orange, yet the file still restores\n\
         because the recovery blocks fill the holes back in.\n\
         \n\
         Second, you can drop your own page images or a PDF straight onto the drop zone.\n\
         The browser decodes whatever image format it understands, or the library reads\n\
         the bytes itself when the browser cannot. You can select several pages of one\n\
         backup at once, in any order; the decoder assembles them into a single file.\n\
         \n\
         Reading the overlay\n\
         \n\
         Green means a block was read cleanly. Yellow and orange mean the reader needed\n\
         more correction before it trusted the block. Red marks a block it could not read\n\
         at all, or one that had to be rebuilt from the recovery data. The overlay is shown\n\
         even when the whole file cannot be restored, because that is exactly when you want\n\
         to see which page went wrong.\n\
         \n\
         Practical notes for scanning\n\
         \n\
         Scan at 300 dots per inch or better, in grayscale, with no sharpening and no\n\
         automatic rotation. Keep the whole sheet inside the frame, including the hint text\n\
         along the bottom edge, and keep the page flat. If a page reads badly, rescanning it\n\
         at a higher resolution usually fixes more than any amount of post-processing. You\n\
         do not have to name the files in any particular way and you do not have to feed the\n\
         pages back in order.\n\
         \n\
         Licences and credits\n\
         \n\
         paperback.rs is free software under the GNU General Public License, version 3 or\n\
         later. It is not affiliated with the original PaperBack, but it honours the format\n\
         that program defined, and it thanks Oleh Yuschuk for designing it. The rest of this\n\
         file is padded with a few numbered sections so that the encoded page fills a\n\
         realistic amount of its grid.\n",
    );

    // Numbered practice sections, each with its own short reference tag so that the text is
    // not one long repetition: the encoded grid should look like a real, well-filled page.
    let mut state: u32 = 0x1234_5678;
    let mut next = || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        state
    };
    let mut section = 1;
    while text.len() < 18_000 {
        let (first, second) = (next(), next());
        text.push_str(&format!(
            "\n\
             Practice section {section}. The sample page you just decoded stores this whole\n\
             file as a grid of dots, and this section exists only so that the grid is densely\n\
             populated. When you inspect the quality overlay, remember that a green block came\n\
             back on the first reading, while a yellow or orange block needed the error\n\
             correction to work harder. A red block is one that the reader gave up on and that\n\
             the recovery data had to rebuild. The number of blocks rebuilt from recovery data\n\
             is reported after every decode, and on the clean sample it must stay at zero.\n\
             Section {section:04} reference: {first:08X}-{second:08X}.\n"
        ));
        section += 1;
    }
    text
}
