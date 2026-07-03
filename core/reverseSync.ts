/**
 * core/reverseSync.ts
 *
 * LaTeX → PDF mapping via `synctex view` CLI command.
 * This is the "reverse" direction of SyncTeX: given a .tex file and line number,
 * find the corresponding position in the PDF.
 *
 * Wraps: synctex view -i "<line>:<col>:<texFile>" -o "<pdfFile>"
 *
 * SyncTeX output example:
 *   SyncTeX result begin
 *   Output:main.pdf
 *   Page:3
 *   x:156.789
 *   y:523.456
 *   h:156.789
 *   v:523.456
 *   W:100.000
 *   H:10.000
 *   before:...
 *   offset:0
 *   middle:...
 *   after:...
 *   SyncTeX result end
 *
 * This mapping is "best-effort": it may return null if the line has no
 * corresponding box in the PDF (e.g. macro definitions, comments, blank lines).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReverseSyncResult } from "../types.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a LaTeX source location to the corresponding position in the PDF.
 *
 * @param texFile  Absolute path to the .tex file.
 * @param line     1-indexed line number.
 * @param pdfFile  Absolute path to the PDF file.
 * @returns        PDF page + bounding box, or null if no match found.
 */
export async function synctexView(
  texFile: string,
  line: number,
  pdfFile: string
): Promise<ReverseSyncResult | null> {
  // synctex view expects column 1 when column is unknown
  const inputSpec = `${line}:1:${texFile}`;

  let stdout: string;
  try {
    const result = await execFileAsync(
      "synctex",
      ["view", "-i", inputSpec, "-o", pdfFile],
      { timeout: 8000 }
    );
    stdout = result.stdout;
  } catch (err: unknown) {
    // synctex view exits with non-zero when no record found — treat as null
    const msg = err instanceof Error ? err.message : String(err);
    if (isNoRecordError(msg)) return null;

    // Binary missing — propagate
    if (isMissingBinaryError(msg)) {
      throw new Error(
        "`synctex` binary not found on PATH. " +
          "Install via your LaTeX distribution (TeX Live / MiKTeX)."
      );
    }

    // Any other error: soft failure (return null so the UI stays usable)
    console.warn(`[latex-pdf-review] synctex view soft failure: ${msg}`);
    return null;
  }

  return parseSynctexViewOutput(stdout);
}

// ---------------------------------------------------------------------------
// Output parser
// ---------------------------------------------------------------------------

function parseSynctexViewOutput(output: string): ReverseSyncResult | null {
  const lines = output.replace(/\r\n/g, "\n").split("\n");

  let page: number | null = null;
  // Prefer 'x'/'y' (box position). Fall back to 'h'/'v' if unavailable.
  let h: number | null = null;
  let v: number | null = null;
  let x: number | null = null;
  let y: number | null = null;
  let W: number | null = null;
  let H: number | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("Page:")) {
      const val = parseInt(trimmed.slice("Page:".length).trim(), 10);
      if (!isNaN(val)) page = val;
    } else if (trimmed.startsWith("x:")) {
      const val = parseFloat(trimmed.slice("x:".length).trim());
      if (!isNaN(val)) x = val;
    } else if (trimmed.startsWith("y:")) {
      const val = parseFloat(trimmed.slice("y:".length).trim());
      if (!isNaN(val)) y = val;
    } else if (trimmed.startsWith("h:")) {
      const val = parseFloat(trimmed.slice("h:".length).trim());
      if (!isNaN(val)) h = val;
    } else if (trimmed.startsWith("v:")) {
      const val = parseFloat(trimmed.slice("v:".length).trim());
      if (!isNaN(val)) v = val;
    } else if (trimmed.startsWith("W:")) {
      const val = parseFloat(trimmed.slice("W:".length).trim());
      if (!isNaN(val)) W = val;
    } else if (trimmed.startsWith("H:")) {
      const val = parseFloat(trimmed.slice("H:".length).trim());
      if (!isNaN(val)) H = val;
    }

    // End of first result block — return what we have
    if (trimmed === "SyncTeX result end") break;
  }

  const finalX = x ?? h;
  const finalY = y ?? v;
  if (page === null || finalX === null || finalY === null) return null;

  return {
    page,
    x: finalX,
    y: finalY,
    width: W ?? 0,
    height: H ?? 0,
    origin: "pdf",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNoRecordError(msg: string): boolean {
  return (
    msg.includes("No SyncTeX") ||
    msg.includes("no result") ||
    // synctex exits 1 with empty stdout when no record matches
    msg.trim() === "" ||
    msg.includes("exited with code 1")
  );
}

function isMissingBinaryError(msg: string): boolean {
  return (
    msg.includes("ENOENT") ||
    msg.includes("not found") ||
    msg.includes("No such file")
  );
}
