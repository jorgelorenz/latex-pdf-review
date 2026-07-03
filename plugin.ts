/**
 * plugin.ts
 *
 * OpenCode plugin entry point for latex-pdf-review.
 *
 * Registers the /latex-pdf-review slash command via the
 * `command.execute.before` hook (same pattern as plannotator opencode-plugin).
 *
 * Flow:
 *   1. User types /latex-pdf-review [optional-path.pdf]
 *   2. Hook fires → suppress .md body (output.parts.length = 0)
 *   3. Resolve PDF path (arg > auto-detect main.pdf)
 *   4. Start local Bun HTTP server
 *   5. Open browser to the split-pane UI
 *   6. Show TUI toast with the URL
 *   7. Server holds the OpenCode client and session ID for review submission
 */

import type { Plugin } from "@opencode-ai/plugin";
import { join, resolve, extname, basename, dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { startServer, type StartedServer } from "./server.ts";

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

const LatexPdfReviewPlugin: Plugin = async (ctx) => {
  // Track running servers so we can clean them up on session end
  const runningServers = new Map<string, StartedServer>();

  return {
    // -----------------------------------------------------------------------
    // Command interception — mirrors plannotator's command.execute.before pattern
    // -----------------------------------------------------------------------
    "command.execute.before": async (input, output) => {
      if (input.command !== "latex-pdf-review") return;

      // 1. Suppress the .md stub body from reaching the agent
      //    (Must mutate in-place — do NOT reassign output.parts)
      output.parts.length = 0;

      const sessionId = input.sessionID;

      // 2. Resolve the PDF path
       let pdfPath: string;
       try {
         pdfPath = resolvePdfPath(input.arguments?.trim() ?? "", ctx.directory);
       } catch (err: unknown) {
         const msg = err instanceof Error ? err.message : String(err);
         await safeShowToast(ctx.client, `latex-pdf-review: ${msg}`, "error");
         return;
       }

      // 2.5. Auto-compile if SyncTeX is missing
      try {
        await ensureSynctex(pdfPath, ctx.directory, ctx.$);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await safeShowToast(
          ctx.client,
          `latex-pdf-review: auto-compile warning — ${msg}`,
          "info"
        );
        // Don't fail — let SyncTeX operations fail gracefully later if needed
      }

      // 3. Stop any previously running server for this session
      const existing = runningServers.get(sessionId);
      if (existing) {
        existing.close();
        runningServers.delete(sessionId);
      }

      // 4. Start the local server
      let server: StartedServer;
      try {
        server = await startServer({
          pdfPath,
          directory: ctx.directory,
          sessionId,
          client: ctx.client,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await safeShowToast(
          ctx.client,
          `latex-pdf-review: failed to start server — ${msg}`,
          "error"
        );
        return;
      }

      runningServers.set(sessionId, server);

      // 5. Open browser (cross-platform)
      const { url } = server;
      try {
        await openBrowser(url, ctx.$);
      } catch {
        // Browser open failure is non-fatal — user can navigate manually
      }

      // 6. Show TUI toast with the URL
      await safeShowToast(
        ctx.client,
        `latex-pdf-review opened at ${url}`,
        "success"
      );

      // 7. Log to OpenCode app log
      try {
        await ctx.client.app.log({
          body: {
            service: "latex-pdf-review",
            level: "info",
            message: "Review session started",
            extra: { url, pdfPath, sessionId },
          },
        });
      } catch {
        // Non-fatal
      }

    },

    // -----------------------------------------------------------------------
    // Clean up servers when the session ends
    // -----------------------------------------------------------------------
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (event.type === "session.idle") {
        const sessionId = event.properties?.sessionID as string | undefined;
        if (!sessionId) return;
        const server = runningServers.get(sessionId);
        if (!server) return;

        try {
          const statusRes = await fetch(`${server.url}/api/status`);
          if (!statusRes.ok) return;
          const status = (await statusRes.json()) as { isAgentBusy: boolean };
          if (!status.isAgentBusy) return;

          await fetch(`${server.url}/api/agent/busy`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ busy: false }),
          });

          await fetch(`${server.url}/api/compile`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });

          await safeShowToast(
            ctx.client,
            "Agent finished: PDF recompiled",
            "success"
          );
        } catch {
          // Non-fatal
        }
      }

      if (event.type === "session.deleted") {
        const sessionId = event.properties?.id as string | undefined;
        if (sessionId) {
          const server = runningServers.get(sessionId);
          if (server) {
            server.close();
            runningServers.delete(sessionId);
          }
        }
      }
    },
  };
};

export default LatexPdfReviewPlugin;

// ---------------------------------------------------------------------------
// Auto-compile with SyncTeX
// ---------------------------------------------------------------------------

/**
 * Ensure that a PDF has SyncTeX data (.synctex.gz).
 * If missing, automatically compile the source .tex file with --synctex=1.
 *
 * @param pdfPath Absolute path to the PDF
 * @param directory Project directory
 * @param $ Bun shell ($) for running commands
 * @throws if compilation fails
 */
async function ensureSynctex(
  pdfPath: string,
  directory: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $: any
): Promise<void> {
  // Check if .synctex.gz exists
  const pdfName = basename(pdfPath);
  const pdfDir = dirname(pdfPath);
  const synctexGz = join(pdfDir, pdfName.replace(/\.pdf$/i, ".synctex.gz"));
  const synctex = join(pdfDir, pdfName.replace(/\.pdf$/i, ".synctex"));

  if (existsSync(synctexGz) || existsSync(synctex)) {
    // SyncTeX already available
    return;
  }

  // SyncTeX missing — try to compile the source .tex file
  const texName = pdfName.replace(/\.pdf$/i, ".tex");
  const texPath = join(pdfDir, texName);

  if (!existsSync(texPath)) {
    throw new Error(`SyncTeX file missing and source .tex not found: ${texPath}`);
  }

  // Try pdflatex first, then latexmk (non-interactive)
  try {
    // Use pdflatex with --synctex=1 and non-interactive mode, suppress output
    await $`cd ${pdfDir} && pdflatex --synctex=1 --interaction=batchmode ${texName} > /dev/null 2>&1`;
    if (!existsSync(synctexGz) && !existsSync(synctex)) {
      throw new Error("pdflatex compiled but no .synctex file was generated");
    }
  } catch {
    // If pdflatex fails, try latexmk
    try {
      await $`cd ${pdfDir} && latexmk -pdf -synctex=1 -interaction=batchmode ${texName} > /dev/null 2>&1`;
      if (!existsSync(synctexGz) && !existsSync(synctex)) {
        throw new Error("latexmk compiled but no .synctex file was generated");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to auto-compile ${texName}. Make sure pdflatex or latexmk is installed.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// PDF path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the PDF path to review.
 * Priority order:
 *   1. Explicit argument passed by the user
 *   2. `main.pdf` in the project directory
 *   3. Any single *.pdf file in the project directory
 *
 * @throws if no PDF can be found
 */
function resolvePdfPath(argument: string, directory: string): string {
  // 1. Explicit argument
  if (argument) {
    const candidate = resolve(directory, argument);
    if (!existsSync(candidate)) {
      throw new Error(`PDF not found: ${candidate}`);
    }
    if (extname(candidate).toLowerCase() !== ".pdf") {
      throw new Error(`Not a PDF file: ${candidate}`);
    }
    return candidate;
  }

  // 2. main.pdf in project root
  const mainPdf = join(directory, "main.pdf");
  if (existsSync(mainPdf)) return mainPdf;

  // 3. Any single PDF in the project root
  try {
    const pdfs = readdirSync(directory)
      .filter((f) => extname(f).toLowerCase() === ".pdf")
      .map((f) => join(directory, f));

    if (pdfs.length === 1) return pdfs[0];

    if (pdfs.length > 1) {
      const names = pdfs.map((p) => p.split(/[\\/]/).pop()).join(", ");
      throw new Error(
        `Multiple PDFs found: ${names}. Pass the filename as an argument: /latex-pdf-review <file.pdf>`
      );
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Multiple PDFs")) throw err;
    // readdir failure — fall through
  }

  throw new Error(
    `No PDF found in ${directory}.\n` +
      `Compile your LaTeX first (e.g. pdflatex --synctex=1 main.tex) or pass a path:\n` +
      `  /latex-pdf-review path/to/file.pdf`
  );
}

// ---------------------------------------------------------------------------
// Cross-platform browser opener
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openBrowser(url: string, $: any): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      // Windows: cmd /c start handles URLs with & and ? correctly
      await $`cmd /c start "" ${url}`;
    } else if (platform === "darwin") {
      // macOS
      await $`open ${url}`;
    } else {
      // Linux / WSL
      await $`xdg-open ${url}`;
    }
  } catch {
    // Best-effort — user can open URL manually from the TUI toast
  }
}

// ---------------------------------------------------------------------------
// Safe TUI toast
// ---------------------------------------------------------------------------

async function safeShowToast(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  message: string,
  variant: "success" | "error" | "info" = "info"
): Promise<void> {
  try {
    await client.tui.showToast({ body: { message, variant } });
  } catch {
    // TUI might not be available (headless mode) — ignore
    if (variant === "error") {
      console.error(`[latex-pdf-review] ${message}`);
    }
  }
}
