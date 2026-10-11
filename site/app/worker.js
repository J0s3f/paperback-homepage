// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Josef H.B. Schneider

// Runs the paperback-rs WebAssembly decoder and encoder away from the page, so that the
// page stays responsive and can show progress while the work is done. The page talks to
// this worker with one message at a time; every message gets exactly one answer.

import init, { version, Decoder, encodeFile } from "../pkg/paperback_web.js";

let decoder = null;

/** Answers the message in flight; `buffers` are moved instead of copied. */
function reply(message, buffers = []) {
  self.postMessage(message, buffers);
}

self.onmessage = async event => {
  const message = event.data;
  try {
    switch (message.type) {
      case "init": {
        await init();
        decoder = new Decoder();
        reply({ type: "ready", version: version() });
        return;
      }

      case "addPage": {
        decoder.addPage(message.width, message.height, message.gray);
        reply({ type: "added", count: 1 });
        return;
      }

      case "addImage": {
        const first = decoder.pageCount();
        const added = decoder.addImage(message.bytes);
        const pages = [];
        const buffers = [];
        for (let index = first; index < decoder.pageCount(); index++) {
          const gray = decoder.pageGray(index);
          pages.push({ width: decoder.pageWidth(index), height: decoder.pageHeight(index), gray });
          buffers.push(gray.buffer);
        }
        reply({ type: "added", count: added, pages }, buffers);
        return;
      }

      case "removePage": {
        decoder.removePage(message.index);
        reply({ type: "removed" });
        return;
      }

      case "clear": {
        decoder.clear();
        reply({ type: "cleared" });
        return;
      }

      case "decode": {
        const total = decoder.pageCount();
        // The callback runs after every page that was read, which is what the progress
        // bar on the page shows; the messages queue up while this worker keeps working.
        const result = decoder.decode(message.password ?? null, index => {
          reply({ type: "progress", phase: "decode", done: index + 1, total });
        });
        const overlays = [];
        const buffers = [];
        for (let index = 0; index < total; index++) {
          const overlay = decoder.overlayData(index);
          overlays.push(overlay);
          if (overlay.length > 0) buffers.push(overlay.buffer);
        }
        const file = decoder.fileData();
        if (file.length > 0) buffers.push(file.buffer);
        reply({ type: "decoded", result, file, overlays }, buffers);
        return;
      }

      case "encode": {
        reply({ type: "progress", phase: "encode", note: "working" });
        const result = encodeFile(message.data, message.name, message.settings);
        const buffers = [];
        for (const page of result.pages) buffers.push(page.png.buffer);
        buffers.push(result.pdf.buffer);
        reply({ type: "encoded", result }, buffers);
        return;
      }

      default:
        reply({ type: "error", message: `unknown message ${message.type}` });
    }
  } catch (error) {
    reply({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
