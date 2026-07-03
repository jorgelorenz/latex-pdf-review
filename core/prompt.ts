/**
 * core/prompt.ts
 *
 * Build the strict review prompt injected into the OpenCode agent session.
 *
 * The prompt format is fixed (as specified in the plugin requirements):
 *
 *   You are editing LaTeX from a PDF review session.
 *   Apply minimal changes only.
 *
 *   COMMENT:
 *   {comment}
 *
 *   LATEX CONTEXT:
 *   {context}
 *
 *   Return ONLY a unified diff.
 *
 * The agent must return a unified diff that can be applied with `patch`.
 * No narrative, no code blocks, just the diff.
 */

import type { Annotation } from "../types.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the full review prompt for the OpenCode agent.
 *
 * @param comment  The human-written review comment from the UI.
 * @param context  The formatted LaTeX context string (from core/context.ts).
 * @returns        The complete prompt string ready for `client.session.prompt()`.
 */
export function buildReviewPrompt(comment: string, context: string): string {
  const trimmedComment = comment.trim();
  const trimmedContext = context.trim();

  return [
    "You are editing LaTeX from a PDF review session.",
    "Apply minimal changes only.",
    "",
    "COMMENT:",
    trimmedComment,
    "",
    "LATEX CONTEXT:",
    trimmedContext,
    "",
    "Return ONLY a unified diff.",
  ].join("\n");
}

/**
 * Build a richer prompt that includes the full annotation metadata.
 * Used when additional traceability context is helpful (e.g. multi-file reviews).
 *
 * @param annotation  The full annotation object.
 * @param context     The formatted LaTeX context string.
 * @returns           The complete prompt string.
 */
export function buildAnnotationPrompt(
  annotation: Annotation,
  context: string
): string {
  const lines: string[] = [
    "You are editing LaTeX from a PDF review session.",
    "Apply minimal changes only.",
    "",
  ];

  // Source location header
  lines.push(
    `SOURCE: ${annotation.texFile}, line ${annotation.texLine}` +
      ` (PDF: ${annotation.pdfFile}, page ${annotation.page})`
  );
  lines.push("");

  // Optional selected text from PDF
  if (annotation.selectedText?.trim()) {
    lines.push("PDF SELECTION:");
    lines.push(annotation.selectedText.trim());
    lines.push("");
  }

  lines.push("COMMENT:");
  lines.push(annotation.comment.trim());
  lines.push("");
  lines.push("LATEX CONTEXT:");
  lines.push(context.trim());
  lines.push("");
  lines.push("INSTRUCTIONS:");
  lines.push("1. Generate a unified diff of the changes needed.");
  lines.push("2. Apply the diff to the file using the edit command.");
  lines.push("3. Confirm the changes were applied.");
  lines.push("");
  lines.push("Return the unified diff AND apply it to the file using your editing tools.");

  return lines.join("\n");
}
