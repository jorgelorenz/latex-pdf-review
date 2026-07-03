/**
 * core/synctex.ts
 *
 * PDF → LaTeX mapping via the `synctex edit` CLI command.
 *
 * Wraps: synctex edit -o "page:x:y:file"
 *
 * SyncTeX output example (one or more records):
 *   SyncTeX record #1:
 *   Page:3
 *   Line:45
 *   Column:7
 *   Input:/path/to/chapters/01-intro.tex
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SyncResult } from "../types.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a PDF location (page + coordinates) to the originating LaTeX source.
 *
 * @param pdfFile  Absolute path to the PDF file.
 * @param page     1-indexed page number.
 * @param x        Horizontal coordinate in PDF points (big points, 72 dpi).
 * @param y        Vertical coordinate in PDF points (big points, 72 dpi).
 * @returns        The resolved LaTeX file and line number.
 * @throws         SynctexError if the binary is missing or parsing fails.
 */
export async function synctexEdit(
  pdfFile: string,
  page: number,
  x: number,
  y: number
): Promise<SyncResult> {
  // Format: synctex edit -o page:x:y:file
  // (not file:page:x:y!)
  const outputSpec = `${page}:${x}:${y}:${pdfFile}`;

  let stdout: string;
  try {
    const result = await execFileAsync("synctex", ["edit", "-o", outputSpec], {
      timeout: 8000,
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    throw new SynctexError(
      buildMissingBinaryMessage(err),
      pdfFile,
      page,
      x,
      y
    );
  }

  return parseSynctexEditOutput(stdout, pdfFile, page, x, y);
}

// ---------------------------------------------------------------------------
// Output parser
// ---------------------------------------------------------------------------

/**
 * Parse the text output of `synctex edit`.
 * Takes the first valid record found.
 */
function parseSynctexEditOutput(
  output: string,
  pdfFile: string,
  page: number,
  x: number,
  y: number
): SyncResult {
  // Normalise line endings
  const lines = output.replace(/\r\n/g, "\n").split("\n");

  let texFile: string | null = null;
  let texLine: number | null = null;
  let texColumn = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("Input:")) {
      texFile = trimmed.slice("Input:".length).trim();
    } else if (trimmed.startsWith("Line:")) {
      const val = parseInt(trimmed.slice("Line:".length).trim(), 10);
      if (!isNaN(val)) texLine = val;
    } else if (trimmed.startsWith("Column:")) {
      const val = parseInt(trimmed.slice("Column:".length).trim(), 10);
      if (!isNaN(val)) texColumn = val;
    }

    // Once we have both required fields for the first record, return early.
    if (texFile !== null && texLine !== null) {
      return { texFile, texLine, texColumn };
    }
  }

  throw new SynctexError(
    `synctex edit returned no valid record for ${pdfFile}:${page}:${x}:${y}.\n` +
      `Raw output:\n${output.slice(0, 500)}`,
    pdfFile,
    page,
    x,
    y
  );
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class SynctexError extends Error {
  constructor(
    message: string,
    public readonly pdfFile: string,
    public readonly page: number,
    public readonly x: number,
    public readonly y: number
  ) {
    super(message);
    this.name = "SynctexError";
  }
}

// ---------------------------------------------------------------------------
// Helper: distinguish "binary not found" from other errors
// ---------------------------------------------------------------------------

function buildMissingBinaryMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (
    msg.includes("ENOENT") ||
    msg.includes("not found") ||
    msg.includes("command not found") ||
    msg.includes("No such file")
  ) {
    return (
      "`synctex` binary not found on PATH.\n" +
      "Install it via your LaTeX distribution:\n" +
      "  • TeX Live: ships with synctex (install texlive-base or full)\n" +
      "  • MiKTeX: synctex is included — run `miktex packages install synctex` if missing\n" +
      "  • Verify with: synctex --version"
    );
  }

  return `synctex edit failed: ${msg}`;
}
