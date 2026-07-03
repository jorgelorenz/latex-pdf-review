/**
 * server.ts
 *
 * Local Bun HTTP server that powers the latex-pdf-review UI.
 * Serves the split-pane browser UI and exposes a JSON API for:
 *   - SyncTeX forward sync (PDF → LaTeX)
 *   - SyncTeX reverse sync (LaTeX → PDF)
 *   - Review submission (injects prompt into OpenCode session)
 *   - Annotation CRUD (in-memory for MVP)
 *   - Static file serving (UI assets)
 *
 * The server is started by plugin.ts when the user runs /latex-pdf-review,
 * receives the OpenCode client + sessionId, and holds them for the lifetime
 * of the review session.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as esbuild from "esbuild";
import { synctexEdit } from "./core/synctex.ts";
import { synctexView } from "./core/reverseSync.ts";
import { extractLatexContext, readTexFile } from "./core/context.ts";
import { buildAnnotationPrompt } from "./core/prompt.ts";
import type {
  Annotation,
  SynctexEditRequest,
  SynctexViewRequest,
  AnnotationSubmitRequest,
  AnnotationSubmitResponse,
  BatchAnnotationSubmitRequest,
  BatchAnnotationSubmitResponse,
  ConfigResponse,
  FileReadResponse,
  ErrorResponse,
  FileSaveRequest,
  FileSaveResponse,
  RecompileResponse,
  UiStatusResponse,
} from "./types.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// UI bundle cache (esbuild result, built once per server process)
// ---------------------------------------------------------------------------
let cachedUiBundle: string | null = null;

/**
 * Build the UI React app bundle using esbuild.
 * All TSX/TS files are transpiled and bundled into a single ESM file.
 * React is kept as an external (loaded from CDN via importmap in index.html).
 */
async function buildUiBundle(uiDirectory: string): Promise<string> {
  if (cachedUiBundle !== null) {
    console.log("[buildUiBundle] Returning cached bundle");
    return cachedUiBundle;
  }

  const entrypoint = join(uiDirectory, "App.tsx");
  console.log("[buildUiBundle] Starting esbuild with entrypoint:", entrypoint);
  
  try {
    const result = await esbuild.build({
      entryPoints: [entrypoint],
      target: "es2020",
      format: "esm",
      bundle: true,
      minify: true,
      external: [
        "react",
        "react-dom",
        "react-dom/client",
      ],
      write: false,
      logLevel: "info",
    });

    if (!result.outputFiles || result.outputFiles.length === 0) {
      throw new Error("esbuild produced no output files");
    }

    cachedUiBundle = new TextDecoder().decode(result.outputFiles[0].contents);
    console.log("[buildUiBundle] Bundle built successfully, size:", cachedUiBundle.length, "bytes");
    return cachedUiBundle;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[buildUiBundle] Build failed:", msg, err);
    throw new Error(`UI bundle build failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

export interface ServerOptions {
  /** Absolute path to the PDF file being reviewed */
  pdfPath: string;
  /** The project root directory */
  directory: string;
  /** OpenCode session ID to inject prompts into */
  sessionId: string;
  /**
   * OpenCode SDK client — used to call session.prompt() and tui.showToast()
   * Typed as `any` to avoid hard dependency on @opencode-ai/sdk at runtime;
   * the plugin.ts passes the live client from the plugin context.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
}

export interface StartedServer {
  /** URL the server is listening on */
  url: string;
  /** Call to shut down the server */
  close: () => void;
}

// ---------------------------------------------------------------------------
// In-memory annotation store (per server instance)
// ---------------------------------------------------------------------------

const annotations: Annotation[] = [];
let reviewSubmitted = false; // Flag set when submit-batch completes
let pdfVersion = 1;
let isCompiling = false;
let isAgentBusy = false;
let compilePromise: Promise<number> | null = null;

// ---------------------------------------------------------------------------
// UI directory resolution
// ---------------------------------------------------------------------------

/** Resolve path to the ui/ directory next to this file */
function uiDir(): string {
  // Works for both Bun (import.meta.url) and Node
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "ui");
  } catch {
    return join(process.cwd(), "plugins", "latex-pdf-review", "ui");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the local HTTP server.
 * Binds to a random available port on 127.0.0.1.
 */
export async function startServer(opts: ServerOptions): Promise<StartedServer> {
  // Find a free port
  const port = await findFreePort(7200);

  // Build the Bun server
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      return handleRequest(req, opts, port);
    },
    error(err) {
      console.error("[latex-pdf-review] server error:", err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    close: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function handleRequest(
  req: Request,
  opts: ServerOptions,
  port: number
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // CORS headers for dev convenience (UI and server are same origin, but just in case)
  const corsHeaders = {
    "Access-Control-Allow-Origin": `http://127.0.0.1:${port}`,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // ---- API routes --------------------------------------------------------

    if (path === "/api/config" && method === "GET") {
      return jsonResponse<ConfigResponse>(
        {
          pdfPath: opts.pdfPath,
          directory: opts.directory,
          sessionId: opts.sessionId,
        },
        corsHeaders
      );
    }

    if (path === "/api/file" && method === "GET") {
      const filePath = url.searchParams.get("path");
      if (!filePath) {
        return errorResponse("Missing ?path= query parameter", 400, corsHeaders);
      }
      const absPath = resolveFilePath(filePath, opts.directory);
      if (!existsSync(absPath)) {
        return errorResponse(`File not found: ${absPath}`, 404, corsHeaders);
      }
      const content = await readTexFile(absPath);
      return jsonResponse<FileReadResponse>({ path: absPath, content }, corsHeaders);
    }

    if (path === "/api/file/save" && method === "POST") {
      const body = (await req.json()) as FileSaveRequest;
      const filePath = body.path;
      const content = body.content;
      if (!filePath || typeof content !== "string") {
        return errorResponse("Missing required fields: path, content", 400, corsHeaders);
      }
      const absPath = resolveFilePath(filePath, opts.directory);
      if (!existsSync(absPath)) {
        return errorResponse(`File not found: ${absPath}`, 404, corsHeaders);
      }
      await writeFile(absPath, content, "utf-8");
      return jsonResponse<FileSaveResponse>({ ok: true, path: absPath }, corsHeaders);
    }

    if (path === "/api/compile" && method === "POST") {
      const nextVersion = await enqueueCompile(opts.pdfPath);
      return jsonResponse<RecompileResponse>(
        {
          ok: true,
          pdfVersion: nextVersion,
        },
        corsHeaders
      );
    }

    if (path === "/api/agent/busy" && method === "POST") {
      const body = (await req.json()) as { busy?: boolean };
      isAgentBusy = Boolean(body?.busy);
      return jsonResponse({ ok: true, isAgentBusy }, corsHeaders);
    }

    if (path === "/api/status" && method === "GET") {
      return jsonResponse<UiStatusResponse>(
        {
          pdfVersion,
          isCompiling,
          isAgentBusy,
        },
        corsHeaders
      );
    }

    if (path === "/api/synctex/edit" && method === "POST") {
      const body = (await req.json()) as SynctexEditRequest;
      const { pdfFile, page, x, y } = body;
      if (!pdfFile || page == null || x == null || y == null) {
        return errorResponse("Missing required fields: pdfFile, page, x, y", 400, corsHeaders);
      }
      const absPdf = resolveFilePath(pdfFile, opts.directory);
      const result = await synctexEdit(absPdf, page, x, y);
      return jsonResponse(result, corsHeaders);
    }

    if (path === "/api/synctex/view" && method === "POST") {
      const body = (await req.json()) as SynctexViewRequest;
      const { texFile, line, pdfFile } = body;
      if (!texFile || line == null || !pdfFile) {
        return errorResponse("Missing required fields: texFile, line, pdfFile", 400, corsHeaders);
      }
      const absTeX = resolveFilePath(texFile, opts.directory);
      const absPdf = resolveFilePath(pdfFile, opts.directory);
      const result = await synctexView(absTeX, line, absPdf);
      // null is a valid response (no match found — UI handles gracefully)
      return jsonResponse(result ?? null, corsHeaders);
    }

    if (path === "/api/annotations" && method === "GET") {
      return jsonResponse(annotations, corsHeaders);
    }

    if (path === "/api/annotations" && method === "POST") {
      const body = (await req.json()) as { annotation: Annotation };
      const annotation = body.annotation;
      if (!annotation?.id) {
        return errorResponse("Invalid annotation object", 400, corsHeaders);
      }
      // Upsert (replace if same id)
      const idx = annotations.findIndex((a) => a.id === annotation.id);
      if (idx >= 0) {
        annotations[idx] = annotation;
      } else {
        annotations.push(annotation);
      }
      return jsonResponse({ ok: true }, corsHeaders);
    }

    if (path === "/api/review/submit" && method === "POST") {
      const body = (await req.json()) as AnnotationSubmitRequest;
      const annotation = body.annotation;
      if (!annotation) {
        return errorResponse("Missing annotation in request body", 400, corsHeaders);
      }

      isAgentBusy = true;
      try {
        // 1. Extract LaTeX context
        const absTeX = resolveFilePath(annotation.texFile, opts.directory);
        const context = await extractLatexContext(absTeX, annotation.texLine);

        // 2. Build the review prompt
        const prompt = buildAnnotationPrompt(annotation, context);

        // 3. Inject into OpenCode session (no external API — uses the live client)
        await opts.client.session.prompt({
          path: { id: opts.sessionId },
          body: {
            parts: [{ type: "text", text: prompt }],
          },
        });

        // 4. Update annotation status in store
        const idx = annotations.findIndex((a) => a.id === annotation.id);
        const updated: Annotation = { ...annotation, reviewStatus: "submitted" };
        if (idx >= 0) {
          annotations[idx] = updated;
        } else {
          annotations.push(updated);
        }

        // 5. Surface a toast in the TUI
        try {
          await opts.client.tui.showToast({
            body: {
              message: `Review submitted for ${annotation.texFile}:${annotation.texLine}`,
              variant: "success",
            },
          });
        } catch {
          // Toast failure is non-fatal
        }

        return jsonResponse<AnnotationSubmitResponse>(
          { ok: true, prompt },
          corsHeaders
        );
      } catch (err: unknown) {
        isAgentBusy = false;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to submit review: ${msg}`);
      }
    }

    // Batch submission — submit all pending annotations at once
    if (path === "/api/review/submit-batch" && method === "POST") {
      const body = (await req.json()) as { annotations: Annotation[] };
      const anns = body.annotations;
      if (!Array.isArray(anns) || anns.length === 0) {
        return errorResponse("Missing or empty annotations array", 400, corsHeaders);
      }

      isAgentBusy = true;
      try {
        // Build a combined prompt for all annotations
        const prompts: string[] = [];
        for (const annotation of anns) {
          const absTeX = resolveFilePath(annotation.texFile, opts.directory);
          const context = await extractLatexContext(absTeX, annotation.texLine);
          const prompt = buildAnnotationPrompt(annotation, context);
          prompts.push(prompt);
        }
        const combinedPrompt = prompts.join("\n\n---\n\n");

        // Inject combined prompt into OpenCode session
        await opts.client.session.prompt({
          path: { id: opts.sessionId },
          body: {
            parts: [{ type: "text", text: combinedPrompt }],
          },
        });

        // Update all annotations in store
        for (const annotation of anns) {
          const idx = annotations.findIndex((a) => a.id === annotation.id);
          const updated: Annotation = { ...annotation, reviewStatus: "submitted" };
          if (idx >= 0) {
            annotations[idx] = updated;
          } else {
            annotations.push(updated);
          }
        }

        // Show toast
        try {
          await opts.client.tui.showToast({
            body: {
              message: `${anns.length} reviews submitted to agent`,
              variant: "success",
            },
          });
        } catch {
          // Toast failure is non-fatal
        }

        // Mark that submission occurred
        reviewSubmitted = true;

        return jsonResponse<BatchAnnotationSubmitResponse>(
          { ok: true, prompt: combinedPrompt, count: anns.length },
          corsHeaders
        );
      } catch (err: unknown) {
        isAgentBusy = false;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to submit review batch: ${msg}`);
      }
    }

    // Check if a review was recently submitted (for plugin polling)
    if (path === "/api/review/submitted" && method === "GET") {
      const submitted = reviewSubmitted;
      reviewSubmitted = false; // Reset flag
      return jsonResponse({ submitted }, corsHeaders);
    }

    // ---- PDF binary serving (for PDF.js) ------------------------------------

    if (path === "/pdf" && method === "GET") {
      const filePath = url.searchParams.get("path");
      if (!filePath) {
        return errorResponse("Missing ?path= query parameter", 400, corsHeaders);
      }
      const absPath = resolveFilePath(filePath, opts.directory);
      if (!existsSync(absPath)) {
        return errorResponse(`PDF not found: ${absPath}`, 404, corsHeaders);
      }
      const pdfBytes = await readFile(absPath);
      return new Response(pdfBytes, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(pdfBytes.byteLength),
          "Cache-Control": "no-store, must-revalidate",
          ETag: `W/\"pdf-${pdfVersion}\"`,
          // Allow PDF.js to load it cross-origin (same origin actually, but safe)
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ---- Static files (UI) -------------------------------------------------

    // Favicon — return 204 No Content to avoid 404 errors
    if (path === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    if (path === "/" || path === "/index.html") {
      const htmlPath = join(uiDir(), "index.html");
      const html = await readFile(htmlPath, "utf-8");
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // /app.js — dynamically bundle the React UI with Bun's native bundler.
    // On first request this takes ~500ms; subsequent requests use the cache.
    if (path === "/app.js") {
      try {
        const bundle = await buildUiBundle(uiDir());
        return new Response(bundle, {
          headers: {
            "Content-Type": "application/javascript",
            "Cache-Control": "no-cache",
          },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(`UI bundle build failed: ${msg}`, 500, corsHeaders);
      }
    }

    // Serve other static assets from ui/
    const staticPath = join(uiDir(), path.slice(1));
    if (existsSync(staticPath)) {
      const content = await readFile(staticPath);
      return new Response(content, {
        headers: { "Content-Type": guessContentType(path) },
      });
    }

    return errorResponse(`Not found: ${path}`, 404, corsHeaders);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[latex-pdf-review] ${method} ${path} error:`, message);
    return errorResponse(message, 500, corsHeaders);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse<T>(
  data: T,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

function errorResponse(
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {}
): Response {
  const body: ErrorResponse = { error: message };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

/**
 * Resolve a file path that may be absolute or relative to the project directory.
 */
function resolveFilePath(filePath: string, directory: string): string {
  if (isAbsolute(filePath)) return filePath;
  return resolve(directory, filePath);
}

/**
 * Find a free TCP port starting from `startPort`.
 */
async function findFreePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      // Try to bind a temporary server — if it succeeds the port is free
      const tmp = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: () => new Response("ok"),
      });
      tmp.stop(true);
      return port;
    } catch {
      // Port busy, try next
    }
  }
  throw new Error(`No free port found in range ${startPort}–${startPort + 99}`);
}

function guessContentType(path: string): string {
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "application/javascript";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

async function enqueueCompile(pdfPath: string): Promise<number> {
  if (compilePromise) {
    return compilePromise;
  }

  compilePromise = runCompile(pdfPath)
    .then((version) => {
      compilePromise = null;
      return version;
    })
    .catch((err) => {
      compilePromise = null;
      throw err;
    });

  return compilePromise;
}

async function runCompile(pdfPath: string): Promise<number> {
  const pdfDir = dirname(pdfPath);
  const pdfName = pdfPath.split(/[\\/]/).pop() ?? "main.pdf";
  const texName = pdfName.replace(/\.pdf$/i, ".tex");
  const texPath = join(pdfDir, texName);
  const beforeMtime = existsSync(pdfPath) ? statSync(pdfPath).mtimeMs : 0;

  if (!existsSync(texPath)) {
    throw new Error(`Source .tex not found for PDF: ${texPath}`);
  }

  isCompiling = true;
  try {
    let lastErrorMessage = "Compilation failed";
    let compiledOk = false;

    try {
      await execFileAsync("pdflatex", ["--synctex=1", "--interaction=nonstopmode", texName], {
        cwd: pdfDir,
        timeout: 120000,
      });
      compiledOk = true;
    } catch (err: unknown) {
      lastErrorMessage = formatCompileError("pdflatex", err);

      try {
        await execFileAsync("latexmk", ["-pdf", "-synctex=1", "-interaction=nonstopmode", texName], {
          cwd: pdfDir,
          timeout: 180000,
        });
        compiledOk = true;
      } catch (err2: unknown) {
        lastErrorMessage = formatCompileError("latexmk", err2);

        try {
          await execFileAsync("latexmk", ["-pdf", "-synctex=1", "-interaction=nonstopmode", "-f", texName], {
            cwd: pdfDir,
            timeout: 180000,
          });
          compiledOk = true;
        } catch (err3: unknown) {
          lastErrorMessage = formatCompileError("latexmk -f", err3);
        }
      }
    }

    if (!existsSync(pdfPath)) {
      throw new Error(`Compilation finished but PDF is missing: ${pdfPath}`);
    }

    const afterMtime = statSync(pdfPath).mtimeMs;
    if (!compiledOk && afterMtime <= beforeMtime) {
      throw new Error(lastErrorMessage);
    }

    pdfVersion += 1;
    return pdfVersion;
  } finally {
    isCompiling = false;
  }
}

function formatCompileError(command: string, err: unknown): string {
  const fallback = err instanceof Error ? err.message : String(err);
  const maybe = err as { stderr?: string; stdout?: string };
  const combined = `${maybe?.stderr ?? ""}\n${maybe?.stdout ?? ""}`.trim();
  if (!combined) {
    return `${command} failed: ${fallback}`;
  }

  const lines = combined
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-12).join(" | ");
  return `${command} failed. Check main.log. ${tail}`;
}
