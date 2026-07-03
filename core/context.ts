/**
 * core/context.ts
 *
 * Extract a ±N-line "context window" from a .tex file centred on a given line.
 * Used to provide the LaTeX agent with enough surrounding code to make
 * minimal, accurate edits.
 */

import { readFile } from "node:fs/promises";

// Default context radius (lines before and after the target line)
const DEFAULT_RADIUS = 40;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a .tex file and return a formatted context slice centred on `targetLine`.
 *
 * The returned string includes line numbers and a `>` marker on the target line:
 *
 *   ...
 *    42 |   the previous line
 *  > 43 |   the selected line            ← targetLine
 *    44 |   the following line
 *   ...
 *
 * @param texFile    Absolute path to the .tex file.
 * @param targetLine 1-indexed line number to centre on.
 * @param radius     Number of lines to include before and after the target.
 * @returns          Formatted context string.
 */
export async function extractLatexContext(
  texFile: string,
  targetLine: number,
  radius: number = DEFAULT_RADIUS
): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(texFile, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read LaTeX file "${texFile}": ${msg}`);
  }

  const allLines = raw.split(/\r?\n/);
  const totalLines = allLines.length;

  // Clamp to valid range (1-indexed → 0-indexed)
  const centre = Math.max(1, Math.min(targetLine, totalLines));
  const firstLine = Math.max(1, centre - radius);
  const lastLine = Math.min(totalLines, centre + radius);

  const lineWidth = String(lastLine).length;
  const contextLines: string[] = [];

  if (firstLine > 1) {
    contextLines.push(`... (lines 1–${firstLine - 1} omitted)`);
  }

  for (let i = firstLine; i <= lastLine; i++) {
    const marker = i === centre ? ">" : " ";
    const lineNum = String(i).padStart(lineWidth, " ");
    contextLines.push(`${marker} ${lineNum} | ${allLines[i - 1]}`);
  }

  if (lastLine < totalLines) {
    contextLines.push(`... (lines ${lastLine + 1}–${totalLines} omitted)`);
  }

  return contextLines.join("\n");
}

// ---------------------------------------------------------------------------
// Utility: read raw file lines (used by server for file-content API)
// ---------------------------------------------------------------------------

/**
 * Read a .tex file and return its full content as a string.
 * Normalises line endings to `\n`.
 */
export async function readTexFile(texFile: string): Promise<string> {
  const raw = await readFile(texFile, "utf-8");
  return raw.replace(/\r\n/g, "\n");
}
