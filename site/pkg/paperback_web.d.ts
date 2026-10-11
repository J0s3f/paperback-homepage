/* tslint:disable */
/* eslint-disable */

/**
 * Reads pages back into the file they were written from.
 *
 * ```js
 * const decoder = new Decoder();
 * decoder.addPage(width, height, grayPixels);   // or decoder.addImage(bytes)
 * const result = decoder.decode(passwordInput.value || null);
 * if (result.compatible) { download(result.fileName, decoder.fileData()); }
 * ```
 */
export class Decoder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Reads image bytes with the library itself — PNG, JPEG, BMP, and the page images
     * of a PDF — and adds every page it finds; returns how many were added.
     *
     * This is the way to add pages the browser cannot decode on its own. Bytes that hold
     * no readable page are a thrown error.
     */
    addImage(bytes: Uint8Array): number;
    /**
     * Adds one 8-bit grayscale page, row by row from the top; the pixels are copied.
     *
     * Sizes the library refuses — a side of zero, or more than 2^29 pixels — and pixel
     * arrays that do not match the size are thrown errors. Adding a page drops the
     * result of an earlier decode, which no longer describes these pages.
     */
    addPage(width: number, height: number, gray: Uint8Array): void;
    /**
     * Drops every page and result; the decoder can be filled again afterwards.
     */
    clear(): void;
    /**
     * Decodes all loaded pages with `password` (nothing but `None` for a backup that is
     * not encrypted) and returns what came of it. `on_page` is called with the index of
     * every page once it has been read, so a caller can show progress while this runs.
     *
     * The result is built anew every time, and holds for every loaded page what reading
     * it gave — good and bad blocks, the bytes error correction repaired, the blocks that
     * needed extra effort — plus the quality overlay of the pages that read. A backup
     * that cannot be restored is not an error but a result: `compatible` is then `false`
     * and `error` says why (missing pages, a wrong password). Only a fault inside the
     * binding throws.
     */
    decode(password?: string | null, on_page?: Function | null): any;
    /**
     * The bytes of the file the last decode restored; empty when it restored none.
     */
    fileData(): Uint8Array;
    /**
     * An empty decoder.
     */
    constructor();
    /**
     * The red, green and blue of the quality overlay of page `index` — the scan of the
     * page with every block in the colour of how well it read — row by row from the top.
     * Empty when that page has no overlay.
     */
    overlayData(index: number): Uint8Array;
    /**
     * How many pages are loaded.
     */
    pageCount(): number;
    /**
     * The gray pixels of page `index` as they were added, row by row from the top; an
     * empty array when there is no such page.
     */
    pageGray(index: number): Uint8Array;
    /**
     * Height of page `index` in pixels, 0 when there is no such page.
     */
    pageHeight(index: number): number;
    /**
     * Width of page `index` in pixels, 0 when there is no such page.
     */
    pageWidth(index: number): number;
    /**
     * Removes the page at `index`; the pages after it move up by one. The result of an
     * earlier decode no longer describes these pages and is dropped. Returns whether
     * there was a page to remove.
     */
    removePage(index: number): boolean;
}

/**
 * Encodes `data` as printable pages and returns them.
 *
 * `settings` is a plain object; every field is optional:
 * `{ preset: "modern" | "balanced" | "legacy", paper: "a4" | "letter", printerDpi, dotDpi,
 * dotPercent, compression: "max" | "fast" | "none", password, marginMils, redundancy,
 * parityPercent }`. The default is the modern preset of the command-line tool (`--modern`):
 * parity blocks instead of the original recovery blocks, filled pages and the file records.
 * `redundancy` overrides the preset's recovery blocks (0 is off, 2 to 10 is one recovery
 * block per that many data blocks); `parityPercent` overrides the parity blocks per 100 data
 * blocks. PNG pages keep the gray levels of the original format; the PDF is pure black and
 * white, as it is made for printing. Every side gets `marginMils` (default 500 = 12.7 mm,
 * print-safe) of margin.
 *
 * The result is `{ fileName, pageCount, dpi, sourceSize, pages: [{ index, width, height, png }],
 * pdf }`, where `png` and `pdf` are `Uint8Array`s.
 */
export function encodeFile(data: Uint8Array, name: string, settings: any): any;

/**
 * The version of the `paperback-rs` library this module was built against.
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_decoder_free: (a: number, b: number) => void;
    readonly decoder_addImage: (a: number, b: number, c: number) => [number, number, number];
    readonly decoder_addPage: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly decoder_clear: (a: number) => void;
    readonly decoder_decode: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly decoder_fileData: (a: number) => [number, number];
    readonly decoder_new: () => number;
    readonly decoder_overlayData: (a: number, b: number) => [number, number];
    readonly decoder_pageCount: (a: number) => number;
    readonly decoder_pageGray: (a: number, b: number) => [number, number];
    readonly decoder_pageHeight: (a: number, b: number) => number;
    readonly decoder_pageWidth: (a: number, b: number) => number;
    readonly decoder_removePage: (a: number, b: number) => number;
    readonly encodeFile: (a: number, b: number, c: number, d: number, e: any) => [number, number, number];
    readonly version: () => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
