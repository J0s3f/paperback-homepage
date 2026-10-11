// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Josef H.B. Schneider

//! The WebAssembly binding of the `paperback-rs` decoder, for the decoder section of
//! <https://paperback.j0s.at>.
//!
//! The decoding itself is entirely the library's: this crate only moves pages and
//! results across the JavaScript boundary and reports what the caller did wrong as a
//! thrown `Error`. A backup that cannot be read is not an error here — it comes back
//! as a result object with `compatible: false` and the reason in `error`.
//!
//! Page numbers are positions in the list of added pages, counting from 0; the library
//! reads the pages in whatever order they were given.

use js_sys::{Array, Function, Object, Reflect, Uint8Array};
use paperback_rs::block::{FileTime, Redundancy};
use paperback_rs::codec::Compression;
use paperback_rs::decode::{DecodeOptions, PageOutcome};
use paperback_rs::encode::{EncodeOptions, Page, encode as encode_pages};
use paperback_rs::imageio::{self, write_pdf, write_png};
use paperback_rs::layout::{Margins, Paper};
use paperback_rs::quality::ColorImage;
use paperback_rs::raster::{self, Raster};
use wasm_bindgen::prelude::*;

/// The version of the pinned `paperback-rs` library.
const PAPERBACK_RS_VERSION: &str = "1.3.0";

/// Margin used on every side of an encoded page when the settings do not say otherwise:
/// 0.5 in (12.7 mm), inside the unprintable edge of ordinary laser and inkjet printers.
const PRINT_SAFE_MARGIN_MILS: usize = 500;

/// The version of the `paperback-rs` library this module was built against.
#[wasm_bindgen(js_name = version)]
pub fn version() -> String {
    PAPERBACK_RS_VERSION.to_string()
}

/// What reading one page gave: its block counts, why it did not read, and the picture
/// the quality is drawn on.
struct PageResult {
    ok: bool,
    error: Option<String>,
    good_blocks: usize,
    bad_blocks: usize,
    restored_bytes: usize,
    effort_blocks: usize,
    misplaced_blocks: usize,
    overlay: Option<ColorImage>,
}

impl PageResult {
    /// A page the library reported nothing about.
    fn not_read() -> Self {
        Self {
            ok: false,
            error: Some("not read".into()),
            good_blocks: 0,
            bad_blocks: 0,
            restored_bytes: 0,
            effort_blocks: 0,
            misplaced_blocks: 0,
            overlay: None,
        }
    }
}

/// What the last decode restored, and how the file was put together.
struct Restore {
    data: Vec<u8>,
    name: String,
    recovered_blocks: usize,
    parity_blocks: usize,
    parity_recovered_blocks: usize,
    misplaced_blocks: usize,
}

/// Reads pages back into the file they were written from.
///
/// ```js
/// const decoder = new Decoder();
/// decoder.addPage(width, height, grayPixels);   // or decoder.addImage(bytes)
/// const result = decoder.decode(passwordInput.value || null);
/// if (result.compatible) { download(result.fileName, decoder.fileData()); }
/// ```
#[wasm_bindgen(js_name = Decoder)]
pub struct Decoder {
    /// The pages as they were added, which is what the next decode works on.
    pages: Vec<Raster>,
    /// What the last decode made of each page, by page number.
    results: Vec<Option<PageResult>>,
    /// The file the last decode restored, when it restored one.
    restore: Option<Restore>,
}

#[wasm_bindgen]
impl Decoder {
    /// An empty decoder.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Decoder {
        Decoder {
            pages: Vec::new(),
            results: Vec::new(),
            restore: None,
        }
    }

    /// Adds one 8-bit grayscale page, row by row from the top; the pixels are copied.
    ///
    /// Sizes the library refuses — a side of zero, or more than 2^29 pixels — and pixel
    /// arrays that do not match the size are thrown errors. Adding a page drops the
    /// result of an earlier decode, which no longer describes these pages.
    #[wasm_bindgen(js_name = addPage)]
    pub fn add_page(
        &mut self,
        width: usize,
        height: usize,
        gray: &[u8],
    ) -> Result<(), JsError> {
        if !raster::size_is_allowed(width, height) {
            let message = format!(
                "addPage: {width}×{height} is not a page size the decoder accepts \
                 (both sides must be above zero, at most 2^29 pixels together)"
            );
            return Err(JsError::new(message.as_str()));
        }
        let Some(expected) = width.checked_mul(height) else {
            let message = format!("addPage: {width}×{height} does not fit in memory");
            return Err(JsError::new(message.as_str()));
        };
        if gray.len() != expected {
            let message =
                format!("addPage: {width}×{height} needs {expected} gray values, got {}", gray.len());
            return Err(JsError::new(message.as_str()));
        }
        let Some(page) = Raster::from_pixels(width, height, gray.to_vec()) else {
            let message = format!("addPage: {width}×{height} does not fit its pixel data");
            return Err(JsError::new(message.as_str()));
        };
        self.pages.push(page);
        self.forget_result();
        Ok(())
    }

    /// Reads image bytes with the library itself — PNG, JPEG, BMP, and the page images
    /// of a PDF — and adds every page it finds; returns how many were added.
    ///
    /// This is the way to add pages the browser cannot decode on its own. Bytes that hold
    /// no readable page are a thrown error.
    #[wasm_bindgen(js_name = addImage)]
    pub fn add_image(&mut self, bytes: &[u8]) -> Result<usize, JsError> {
        let pages = imageio::read_pages(bytes)
            .map_err(|error| JsError::new(&format!("addImage: {error}")))?;
        if pages.is_empty() {
            return Err(JsError::new("addImage: the file holds no readable page"));
        }
        let added = pages.len();
        self.pages.extend(pages);
        self.forget_result();
        Ok(added)
    }

    /// How many pages are loaded.
    #[wasm_bindgen(js_name = pageCount)]
    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    /// Width of page `index` in pixels, 0 when there is no such page.
    #[wasm_bindgen(js_name = pageWidth)]
    pub fn page_width(&self, index: usize) -> usize {
        self.pages.get(index).map_or(0, Raster::width)
    }

    /// Height of page `index` in pixels, 0 when there is no such page.
    #[wasm_bindgen(js_name = pageHeight)]
    pub fn page_height(&self, index: usize) -> usize {
        self.pages.get(index).map_or(0, Raster::height)
    }

    /// The gray pixels of page `index` as they were added, row by row from the top; an
    /// empty array when there is no such page.
    #[wasm_bindgen(js_name = pageGray)]
    pub fn page_gray(&self, index: usize) -> Vec<u8> {
        self.pages
            .get(index)
            .map(|page| page.pixels().to_vec())
            .unwrap_or_default()
    }

    /// Decodes all loaded pages with `password` (nothing but `None` for a backup that is
    /// not encrypted) and returns what came of it. `on_page` is called with the index of
    /// every page once it has been read, so a caller can show progress while this runs.
    ///
    /// The result is built anew every time, and holds for every loaded page what reading
    /// it gave — good and bad blocks, the bytes error correction repaired, the blocks that
    /// needed extra effort — plus the quality overlay of the pages that read. A backup
    /// that cannot be restored is not an error but a result: `compatible` is then `false`
    /// and `error` says why (missing pages, a wrong password). Only a fault inside the
    /// binding throws.
    #[wasm_bindgen(js_name = decode)]
    pub fn decode(
        &mut self,
        password: Option<String>,
        on_page: Option<Function>,
    ) -> Result<JsValue, JsValue> {
        // The pages move into the call, so that the quality overlays and the block counts
        // can be written next to them; they come back whatever the decode did.
        let pages = std::mem::take(&mut self.pages);
        let mut results: Vec<Option<PageResult>> = (0..pages.len()).map(|_| None).collect();
        let options = DecodeOptions {
            password,
            // The overlay is the point of the web decoder: it is the one thing that shows
            // how well a page read when the file could not be restored at all.
            quality: true,
            diagnose: false,
            require_hash: false,
            // One thread is one answer in the browser, where there are no others anyway.
            threads: 1,
        };
        let decoded = paperback_rs::decode::decode(&pages, &options, |outcome| {
            let PageOutcome {
                index,
                result,
                quality,
            } = outcome;
            let overlay = quality.map(|quality| quality.overlay());
            let record = match result {
                Ok(statistics) => PageResult {
                    ok: true,
                    error: None,
                    good_blocks: statistics.good_blocks,
                    bad_blocks: statistics.bad_blocks,
                    restored_bytes: statistics.restored_bytes,
                    effort_blocks: statistics.effort_blocks,
                    misplaced_blocks: statistics.misplaced_blocks,
                    overlay,
                },
                Err(error) => PageResult {
                    ok: false,
                    error: Some(error),
                    good_blocks: 0,
                    bad_blocks: 0,
                    restored_bytes: 0,
                    effort_blocks: 0,
                    misplaced_blocks: 0,
                    overlay,
                },
            };
            if let Some(slot) = results.get_mut(index) {
                *slot = Some(record);
            }
            if let Some(callback) = &on_page {
                // Progress only; a callback that throws must not break the decode.
                let _ = callback.call1(&JsValue::NULL, &JsValue::from_f64(index as f64));
            }
        });
        // A page the library skipped without reading — the file was complete already —
        // has no outcome of its own; it still gets an entry, so that page `index` of the
        // result always belongs to page `index`.
        for result in &mut results {
            if result.is_none() {
                *result = Some(PageResult::not_read());
            }
        }

        let (restored, error) = match decoded {
            Ok(restored) => {
                let report = restored.report;
                (
                    Some(Restore {
                        data: restored.data,
                        name: restored.name,
                        recovered_blocks: report.recovered_blocks,
                        parity_blocks: report.parity_blocks,
                        parity_recovered_blocks: report.parity_recovered_blocks,
                        misplaced_blocks: report.misplaced_blocks,
                    }),
                    None,
                )
            }
            Err(error) => (None, Some(error.to_string())),
        };

        self.pages = pages;
        self.results = results;
        self.restore = restored;
        self.result_object(error.as_deref())
    }

    /// The bytes of the file the last decode restored; empty when it restored none.
    #[wasm_bindgen(js_name = fileData)]
    pub fn file_data(&self) -> Vec<u8> {
        self.restore.as_ref().map(|restored| restored.data.clone()).unwrap_or_default()
    }

    /// The red, green and blue of the quality overlay of page `index` — the scan of the
    /// page with every block in the colour of how well it read — row by row from the top.
    /// Empty when that page has no overlay.
    #[wasm_bindgen(js_name = overlayData)]
    pub fn overlay_data(&self, index: usize) -> Vec<u8> {
        self.results
            .get(index)
            .and_then(Option::as_ref)
            .and_then(|result| result.overlay.as_ref())
            .map(|overlay| overlay.rgb().to_vec())
            .unwrap_or_default()
    }

    /// Drops every page and result; the decoder can be filled again afterwards.
    #[wasm_bindgen(js_name = clear)]
    pub fn clear(&mut self) {
        self.pages.clear();
        self.forget_result();
    }

    /// Removes the page at `index`; the pages after it move up by one. The result of an
    /// earlier decode no longer describes these pages and is dropped. Returns whether
    /// there was a page to remove.
    #[wasm_bindgen(js_name = removePage)]
    pub fn remove_page(&mut self, index: usize) -> bool {
        if index >= self.pages.len() {
            return false;
        }
        self.pages.remove(index);
        self.forget_result();
        true
    }
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder {
    /// Forgets the result of the last decode; the pages stay.
    fn forget_result(&mut self) {
        self.results = Vec::new();
        self.restore = None;
    }

    /// The result object handed to JavaScript, from what the last decode stored.
    fn result_object(&self, error: Option<&str>) -> Result<JsValue, JsValue> {
        let restored = self.restore.as_ref();
        let object = Object::new();
        // A restored file has nothing wrong with it, so `error` belongs to the failure.
        let error = restored.is_none().then_some(error).flatten();
        put(&object, "compatible", &JsValue::from_bool(restored.is_some()))?;
        put(&object, "error", &optional(error))?;
        put(&object, "fileName", &optional(restored.map(|restored| restored.name.as_str())))?;
        put(&object, "fileSize", &number(restored.map_or(0, |restored| restored.data.len())))?;
        put(
            &object,
            "recoveredBlocks",
            &number(restored.map_or(0, |restored| restored.recovered_blocks)),
        )?;
        put(
            &object,
            "parityBlocks",
            &number(restored.map_or(0, |restored| restored.parity_blocks)),
        )?;
        put(
            &object,
            "parityRecoveredBlocks",
            &number(restored.map_or(0, |restored| restored.parity_recovered_blocks)),
        )?;
        put(
            &object,
            "misplacedBlocks",
            &number(restored.map_or(0, |restored| restored.misplaced_blocks)),
        )?;
        put(&object, "pageCount", &number(self.pages.len()))?;
        let pages = Array::new();
        for (index, result) in self.results.iter().enumerate() {
            pages.push(&self.page_object(index, result.as_ref())?);
        }
        put(&object, "pages", &pages.into())?;
        Ok(object.into())
    }

    /// One entry of the `pages` array of the result.
    fn page_object(&self, index: usize, result: Option<&PageResult>) -> Result<JsValue, JsValue> {
        let (overlay_width, overlay_height) = result
            .and_then(|result| result.overlay.as_ref())
            .map_or((0, 0), |overlay| (overlay.width(), overlay.height()));
        let count = |value: Option<&usize>| number(value.copied().unwrap_or(0));
        let object = Object::new();
        put(&object, "index", &number(index))?;
        put(&object, "ok", &JsValue::from_bool(result.is_some_and(|result| result.ok)))?;
        put(
            &object,
            "error",
            &optional(result.and_then(|result| result.error.as_deref())),
        )?;
        put(&object, "goodBlocks", &count(result.map(|result| &result.good_blocks)))?;
        put(&object, "badBlocks", &count(result.map(|result| &result.bad_blocks)))?;
        put(
            &object,
            "restoredBytes",
            &count(result.map(|result| &result.restored_bytes)),
        )?;
        put(
            &object,
            "effortBlocks",
            &count(result.map(|result| &result.effort_blocks)),
        )?;
        put(
            &object,
            "misplacedBlocks",
            &count(result.map(|result| &result.misplaced_blocks)),
        )?;
        put(&object, "overlayWidth", &number(overlay_width))?;
        put(&object, "overlayHeight", &number(overlay_height))?;
        Ok(object.into())
    }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/// Encodes `data` as printable pages and returns them.
///
/// `settings` is a plain object; every field is optional:
/// `{ preset: "modern" | "balanced" | "legacy", paper: "a4" | "letter", printerDpi, dotDpi,
/// dotPercent, compression: "max" | "fast" | "none", password, marginMils, redundancy,
/// parityPercent }`. The default is the modern preset of the command-line tool (`--modern`):
/// parity blocks instead of the original recovery blocks, filled pages and the file records.
/// `redundancy` overrides the preset's recovery blocks (0 is off, 2 to 10 is one recovery
/// block per that many data blocks); `parityPercent` overrides the parity blocks per 100 data
/// blocks. PNG pages keep the gray levels of the original format; the PDF is pure black and
/// white, as it is made for printing. Every side gets `marginMils` (default 500 = 12.7 mm,
/// print-safe) of margin.
///
/// The result is `{ fileName, pageCount, dpi, sourceSize, pages: [{ index, width, height, png }],
/// pdf }`, where `png` and `pdf` are `Uint8Array`s.
#[wasm_bindgen(js_name = encodeFile)]
pub fn encode_file(data: &[u8], name: &str, settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = settings_object(settings);
    let mut options = preset_options(&settings)?;
    apply_setup(&mut options, &settings)?;
    // Print-safe margins by default: the printable area of most printers stops short of
    // the paper edge, and paper that is clipped cannot be scanned back.
    let margin = number_setting(&settings, "marginMils")?.map_or(PRINT_SAFE_MARGIN_MILS, |mils| {
        mils as usize
    });
    options.setup.margins = Margins {
        left: margin,
        right: margin,
        top: margin,
        bottom: margin,
    };
    if let Some(compression) = string_setting(&settings, "compression")? {
        options.compression = match compression.as_str() {
            "max" | "maximal" => Compression::Maximal,
            "fast" => Compression::Fast,
            "none" => Compression::None,
            other => {
                return Err(JsValue::from_str(&format!(
                    "compression {other:?} is not max, fast or none"
                )));
            }
        };
    }
    if let Some(redundancy) = count_setting(&settings, "redundancy")? {
        // PaperBack's recovery blocks: one per group of this many data blocks; 0 is off.
        options.redundancy = match redundancy {
            0 => None,
            n @ 2..=10 => Some(Redundancy::new(n as u8).ok_or_else(|| {
                JsValue::from_str("redundancy must be 0 or between 2 and 10")
            })?),
            other => {
                return Err(JsValue::from_str(&format!(
                    "redundancy {other} is not 0 or between 2 and 10"
                )));
            }
        };
    }
    if let Some(parity) = count_setting(&settings, "parityPercent")? {
        // Parity blocks per 100 data blocks; the original programs ignore them.
        options.parity_percent = parity;
    }
    options.password = string_setting(&settings, "password")?.filter(|password| !password.is_empty());
    options.name = stored_name(name);
    options.modified = FileTime::from_unix_seconds((js_sys::Date::now() / 1000.0) as u64);

    let pages = encode_pages(data, &options)
        .map_err(|error| JsValue::from_str(&format!("encode: {error}")))?;
    // Every page gets a print-safe margin of white around it: printed at 100 %, the dots
    // and the text stay that far inside the paper edge. The page is not stretched onto the
    // whole sheet — the library's reader wants the dot grid to be the picture, not a speck
    // on a large white canvas (sparse pages become unreadable otherwise).
    let pages: Vec<Page> = pages
        .iter()
        .map(|page| with_print_margin(page, margin))
        .collect();
    let pdf = write_pdf(&printable(&pages));

    let page_objects = Array::new();
    for (index, page) in pages.iter().enumerate() {
        let png =
            write_png(page).map_err(|error| JsValue::from_str(&format!("encode: {error}")))?;
        let object = Object::new();
        put(&object, "index", &number(index))?;
        put(&object, "width", &number(page.raster.width()))?;
        put(&object, "height", &number(page.raster.height()))?;
        put(&object, "png", &Uint8Array::from(png.as_slice()).into())?;
        page_objects.push(&object);
    }

    let object = Object::new();
    put(&object, "fileName", &JsValue::from_str(name))?;
    put(&object, "pageCount", &number(pages.len()))?;
    put(&object, "dpi", &number(pages.first().map_or(0, |page| page.dpi as usize)))?;
    put(&object, "sourceSize", &number(data.len()))?;
    put(&object, "pages", &page_objects.into())?;
    put(&object, "pdf", &Uint8Array::from(pdf.as_slice()).into())?;
    Ok(object.into())
}

/// The PDF pages the way the command-line tool makes them: black and white, because a PDF is
/// printed.
fn printable(pages: &[Page]) -> Vec<Page> {
    pages.iter().map(Page::black_and_white).collect()
}

/// Adds a white border of `margin_mils` around the encoded page, so the picture carries
/// the print-safe margin with it. The page is left at its own size otherwise: the library's
/// reader finds the grid best when the grid is the picture (padding a sparse page onto a
/// whole sheet makes it unreadable).
fn with_print_margin(page: &Page, margin_mils: usize) -> Page {
    let border = margin_mils * page.dpi as usize / 1000;
    if border == 0 {
        return page.clone();
    }
    let width = page.raster.width() + 2 * border;
    let height = page.raster.height() + 2 * border;
    if !raster::size_is_allowed(width, height) {
        // An extreme resolution; leave the page as it is.
        return page.clone();
    }
    let mut sheet = Raster::filled(width, height, raster::WHITE);
    sheet.paste(&page.raster, border, border);
    Page {
        raster: sheet,
        dpi: page.dpi,
    }
}

/// The options of a named preset.
fn preset_options(settings: &JsValue) -> Result<EncodeOptions, JsValue> {
    let preset = string_setting(settings, "preset")?.unwrap_or_else(|| "modern".to_string());
    Ok(match preset.as_str() {
        "modern" => EncodeOptions::modern(),
        "balanced" => EncodeOptions::balanced(),
        "legacy" => EncodeOptions::legacy(),
        other => {
            return Err(JsValue::from_str(&format!(
                "preset {other:?} is not modern, balanced or legacy"
            )));
        }
    })
}

/// Applies the page geometry fields of the settings object.
fn apply_setup(options: &mut EncodeOptions, settings: &JsValue) -> Result<(), JsValue> {
    if let Some(paper) = string_setting(settings, "paper")? {
        options.setup.paper = match paper.as_str() {
            "a4" => Paper::A4,
            "letter" => Paper::Letter,
            other => {
                return Err(JsValue::from_str(&format!(
                    "paper {other:?} is not a4 or letter"
                )));
            }
        };
    }
    if let Some(dpi) = number_setting(settings, "printerDpi")? {
        options.setup.printer_dpi = dpi as usize;
    }
    if let Some(dpi) = number_setting(settings, "dotDpi")? {
        options.setup.dot_dpi = dpi as usize;
    }
    if let Some(percent) = number_setting(settings, "dotPercent")? {
        options.setup.dot_percent = percent as usize;
    }
    Ok(())
}

/// The settings object, or an empty one for `undefined`/`null`.
fn settings_object(settings: JsValue) -> JsValue {
    if settings.is_undefined() || settings.is_null() {
        Object::new().into()
    } else {
        settings
    }
}

/// A field of the settings object, `None` when it is absent, `undefined` or `null`.
fn setting(settings: &JsValue, key: &str) -> Result<Option<JsValue>, JsValue> {
    let value = Reflect::get(settings, &JsValue::from_str(key))
        .map_err(|_| JsValue::from_str("the settings object could not be read"))?;
    Ok((!value.is_undefined() && !value.is_null()).then_some(value))
}

/// A string field of the settings object.
fn string_setting(settings: &JsValue, key: &str) -> Result<Option<String>, JsValue> {
    match setting(settings, key)? {
        Some(value) => value
            .as_string()
            .map(Some)
            .ok_or_else(|| JsValue::from_str(&format!("{key} must be a string"))),
        None => Ok(None),
    }
}

/// A whole-number field of the settings object.
fn number_setting(settings: &JsValue, key: &str) -> Result<Option<u32>, JsValue> {
    match setting(settings, key)? {
        Some(value) => {
            let number = value
                .as_f64()
                .filter(|number| {
                    number.is_finite()
                        && number.fract() == 0.0
                        && *number >= 1.0
                        && *number <= 10_000.0
                })
                .ok_or_else(|| {
                    JsValue::from_str(&format!("{key} must be a whole number above zero"))
                })?;
            Ok(Some(number as u32))
        }
        None => Ok(None),
    }
}

/// A whole-number field that may be zero (redundancy, parity).
fn count_setting(settings: &JsValue, key: &str) -> Result<Option<u32>, JsValue> {
    match setting(settings, key)? {
        Some(value) => {
            let number = value
                .as_f64()
                .filter(|number| {
                    number.is_finite()
                        && number.fract() == 0.0
                        && *number >= 0.0
                        && *number <= 10_000.0
                })
                .ok_or_else(|| {
                    JsValue::from_str(&format!("{key} must be a whole number, 0 or above"))
                })?;
            Ok(Some(number as u32))
        }
        None => Ok(None),
    }
}

/// The name stored on the pages. The on-paper format keeps 31 bytes; a longer name is
/// shortened at a character boundary, and the extension is kept — a file restored
/// without one would be given the wrong kind by some browsers (macOS Safari saves
/// extensionless downloads as ".dms").
fn stored_name(name: &str) -> String {
    const LIMIT: usize = 31;
    if name.len() <= LIMIT {
        return name.to_string();
    }
    let plain = || truncate_at_char_boundary(name, LIMIT).to_string();
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return plain();
    };
    if stem.is_empty() || extension.is_empty() || extension.len() > 10 {
        return plain();
    }
    let keep = LIMIT - extension.len() - 1;
    format!("{}.{extension}", truncate_at_char_boundary(stem, keep))
}

/// `text` shortened to at most `max_bytes`, without splitting a character.
fn truncate_at_char_boundary(text: &str, max_bytes: usize) -> &str {
    let mut end = text.len().min(max_bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Sets a field of a plain JavaScript object.
fn put(object: &Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(key), value)
        .map(|_| ())
        .map_err(|_| JsValue::from_str("could not fill in a field of the result object"))
}

/// A count as a JavaScript number.
fn number(value: usize) -> JsValue {
    JsValue::from_f64(value as f64)
}

/// A string, or `null` where there is none.
fn optional(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from_str)
}
