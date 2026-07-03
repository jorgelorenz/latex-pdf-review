import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { synctexEdit } from "./core/synctex.ts";
import { synctexView } from "./core/reverseSync.ts";
import { extractLatexContext, readTexFile } from "./core/context.ts";
import { buildAnnotationPrompt } from "./core/prompt.ts";
import type {
  Annotation,
  AnnotationSubmitResponse,
  ConfigResponse,
  ErrorResponse,
  FileReadResponse,
  FileSaveRequest,
  FileSaveResponse,
  RecompileResponse,
  SynctexEditRequest,
  SynctexViewRequest,
  UiStatusResponse,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const BunRuntime = globalThis.Bun as any;

export interface ServerOptions {
  pdfPath: string;
  directory: string;
  sessionId: string;
  client: {
    session: { prompt: (...args: any[]) => unknown };
    tui?: { showToast?: (...args: any[]) => unknown };
  };
}

export interface StartedServer {
  url: string;
  browserUrl: string;
  sessionToken: string;
  close: () => void;
}

interface ServerState {
  annotations: Annotation[];
  reviewSubmitted: boolean;
  pdfVersion: number;
  isCompiling: boolean;
  isAgentBusy: boolean;
  compilePromise: Promise<number> | null;
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export async function startServer(opts: ServerOptions): Promise<StartedServer> {
  const port = await findFreePort(7200);
  const uiDirectory = resolveUiDirectory();
  const sessionToken = createSessionToken();
  const state: ServerState = {
    annotations: [],
    reviewSubmitted: false,
    pdfVersion: 1,
    isCompiling: false,
    isAgentBusy: false,
    compilePromise: null,
  };

  const server = BunRuntime?.serve({
    port,
    hostname: "127.0.0.1",
    fetch: (req) => handleRequest(req, opts, state, uiDirectory, sessionToken, port),
    error(err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${port}`,
    browserUrl: `http://127.0.0.1:${port}/?session=${encodeURIComponent(sessionToken)}`,
    sessionToken,
    close: () => server.stop(true),
  };
}

async function handleRequest(
  req: Request,
  opts: ServerOptions,
  state: ServerState,
  uiDirectory: string,
  sessionToken: string,
  port: number
): Promise<Response> {
  const url = new URL(req.url);
  const path = normalizeUrlPath(url.pathname);
  const method = req.method.toUpperCase();

  const baseHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": `http://127.0.0.1:${port}`,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Latex-Review-Session",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  const isPublicRoute =
    path === "/" ||
    path === "/index.html" ||
    path === "/app.js" ||
    path === "/favicon.ico" ||
    path.startsWith("/assets/");
  if (!isPublicRoute && !isAuthorizedRequest(req, sessionToken, url)) {
    return errorResponse("Unauthorized request", 401, baseHeaders);
  }

  try {
    if (path === "/api/config" && method === "GET") {
      return jsonResponse<ConfigResponse>(
        {
          pdfPath: opts.pdfPath,
          directory: opts.directory,
          sessionId: opts.sessionId,
        },
        baseHeaders
      );
    }

    if (path === "/api/file" && method === "GET") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return errorResponse("Missing ?path= query parameter", 400, baseHeaders);

      const absPath = resolveWorkspacePath(filePath, opts.directory);
      if (extname(absPath).toLowerCase() !== ".tex") {
        return errorResponse("Only .tex files are allowed", 400, baseHeaders);
      }
      if (!existsSync(absPath)) return errorResponse(`File not found: ${absPath}`, 404, baseHeaders);

      const content = await readTexFile(absPath);
      return jsonResponse<FileReadResponse>({ path: absPath, content }, baseHeaders);
    }

    if (path === "/api/file/save" && method === "POST") {
      const body = await parseJsonBody<FileSaveRequest>(req);
      if (!body.path || typeof body.content !== "string") {
        return errorResponse("Missing required fields: path, content", 400, baseHeaders);
      }

      const absPath = resolveWorkspacePath(body.path, opts.directory);
      if (extname(absPath).toLowerCase() !== ".tex") {
        return errorResponse("Only .tex files can be saved", 400, baseHeaders);
      }
      if (!existsSync(absPath)) return errorResponse(`File not found: ${absPath}`, 404, baseHeaders);

      await writeFile(absPath, body.content, "utf-8");
      return jsonResponse<FileSaveResponse>({ ok: true, path: absPath }, baseHeaders);
    }

    if (path === "/api/compile" && method === "POST") {
      const nextVersion = await enqueueCompile(opts.pdfPath, state);
      return jsonResponse<RecompileResponse>({ ok: true, pdfVersion: nextVersion }, baseHeaders);
    }

    if (path === "/api/agent/busy" && method === "POST") {
      const body = await parseJsonBody<{ busy?: boolean }>(req);
      state.isAgentBusy = Boolean(body.busy);
      return jsonResponse({ ok: true, isAgentBusy: state.isAgentBusy }, baseHeaders);
    }

    if (path === "/api/status" && method === "GET") {
      return jsonResponse<UiStatusResponse>(
        {
          pdfVersion: state.pdfVersion,
          isCompiling: state.isCompiling,
          isAgentBusy: state.isAgentBusy,
        },
        baseHeaders
      );
    }

    if (path === "/api/synctex/edit" && method === "POST") {
      const body = await parseJsonBody<SynctexEditRequest>(req);
      if (!body.pdfFile || !isPositiveNumber(body.page) || !isFiniteNumber(body.x) || !isFiniteNumber(body.y)) {
        return errorResponse("Missing or invalid fields: pdfFile, page, x, y", 400, baseHeaders);
      }

      const absPdf = resolveWorkspacePath(body.pdfFile, opts.directory);
      if (extname(absPdf).toLowerCase() !== ".pdf") {
        return errorResponse("pdfFile must point to a .pdf file", 400, baseHeaders);
      }
      const result = await synctexEdit(absPdf, body.page, body.x, body.y);
      return jsonResponse(result, baseHeaders);
    }

    if (path === "/api/synctex/view" && method === "POST") {
      const body = await parseJsonBody<SynctexViewRequest>(req);
      if (!body.texFile || !isPositiveNumber(body.line) || !body.pdfFile) {
        return errorResponse("Missing or invalid fields: texFile, line, pdfFile", 400, baseHeaders);
      }

      const absTeX = resolveWorkspacePath(body.texFile, opts.directory);
      const absPdf = resolveWorkspacePath(body.pdfFile, opts.directory);
      if (extname(absTeX).toLowerCase() !== ".tex") {
        return errorResponse("texFile must point to a .tex file", 400, baseHeaders);
      }
      if (extname(absPdf).toLowerCase() !== ".pdf") {
        return errorResponse("pdfFile must point to a .pdf file", 400, baseHeaders);
      }
      const result = await synctexView(absTeX, body.line, absPdf);
      return jsonResponse(result ?? null, baseHeaders);
    }

    if (path === "/api/annotations" && method === "GET") {
      return jsonResponse(state.annotations, baseHeaders);
    }

    if (path === "/api/annotations" && method === "POST") {
      const body = await parseJsonBody<{ annotation?: Annotation }>(req);
      const annotation = body.annotation;
      if (!annotation || !annotation.id) {
        return errorResponse("Invalid annotation object", 400, baseHeaders);
      }

      const idx = state.annotations.findIndex((a) => a.id === annotation.id);
      if (idx >= 0) state.annotations[idx] = annotation;
      else state.annotations.push(annotation);

      return jsonResponse({ ok: true }, baseHeaders);
    }

    if (path === "/api/review/submit" && method === "POST") {
      const body = await parseJsonBody<{ annotation?: Annotation }>(req);
      const annotation = body.annotation;
      if (!annotation) return errorResponse("Missing annotation in request body", 400, baseHeaders);

      state.isAgentBusy = true;
      try {
        const absTeX = resolveWorkspacePath(annotation.texFile, opts.directory);
        const context = await extractLatexContext(absTeX, annotation.texLine);
        const prompt = buildAnnotationPrompt(annotation, context);

        await opts.client.session.prompt({
          path: { id: opts.sessionId },
          body: { parts: [{ type: "text", text: prompt }] },
        });

        const idx = state.annotations.findIndex((a) => a.id === annotation.id);
        const updated: Annotation = { ...annotation, reviewStatus: "submitted" };
        if (idx >= 0) state.annotations[idx] = updated;
        else state.annotations.push(updated);

        await maybeShowToast(opts.client, `Review submitted for ${annotation.texFile}:${annotation.texLine}`, "success");
        return jsonResponse<AnnotationSubmitResponse>({ ok: true, prompt }, baseHeaders);
      } catch (err: unknown) {
        state.isAgentBusy = false;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to submit review: ${msg}`);
      }
    }

    if (path === "/api/review/submit-batch" && method === "POST") {
      const body = await parseJsonBody<{ annotations?: Annotation[] }>(req);
      const anns = body.annotations;
      if (!Array.isArray(anns) || anns.length === 0) {
        return errorResponse("Missing or empty annotations array", 400, baseHeaders);
      }

      state.isAgentBusy = true;
      try {
        const prompts: string[] = [];
        for (const annotation of anns) {
          const absTeX = resolveWorkspacePath(annotation.texFile, opts.directory);
          const context = await extractLatexContext(absTeX, annotation.texLine);
          prompts.push(buildAnnotationPrompt(annotation, context));
        }
        const combinedPrompt = prompts.join("\n\n---\n\n");

        await opts.client.session.prompt({
          path: { id: opts.sessionId },
          body: { parts: [{ type: "text", text: combinedPrompt }] },
        });

        for (const annotation of anns) {
          const idx = state.annotations.findIndex((a) => a.id === annotation.id);
          const updated: Annotation = { ...annotation, reviewStatus: "submitted" };
          if (idx >= 0) state.annotations[idx] = updated;
          else state.annotations.push(updated);
        }

        state.reviewSubmitted = true;
        await maybeShowToast(opts.client, `${anns.length} reviews submitted to agent`, "success");
        return jsonResponse({ ok: true, prompt: combinedPrompt, count: anns.length }, baseHeaders);
      } catch (err: unknown) {
        state.isAgentBusy = false;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to submit review batch: ${msg}`);
      }
    }

    if (path === "/api/review/submitted" && method === "GET") {
      const submitted = state.reviewSubmitted;
      state.reviewSubmitted = false;
      return jsonResponse({ submitted }, baseHeaders);
    }

    if (path === "/pdf" && method === "GET") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return errorResponse("Missing ?path= query parameter", 400, baseHeaders);

      const absPath = resolveWorkspacePath(filePath, opts.directory);
      if (extname(absPath).toLowerCase() !== ".pdf") {
        return errorResponse("Only .pdf files are allowed", 400, baseHeaders);
      }
      if (!existsSync(absPath)) return errorResponse(`PDF not found: ${absPath}`, 404, baseHeaders);

      const pdfBytes = await readFile(absPath);
      return new Response(pdfBytes, {
        status: 200,
        headers: {
          ...baseHeaders,
          "Content-Type": "application/pdf",
          "Content-Length": String(pdfBytes.byteLength),
          ETag: `W/"pdf-${state.pdfVersion}"`,
        },
      });
    }

    if (path === "/favicon.ico") {
      return new Response(null, { status: 204, headers: baseHeaders });
    }

    if (path === "/" || path === "/index.html") {
      const html = await readFile(join(uiDirectory, "index.html"), "utf-8");
      return new Response(html, {
        status: 200,
        headers: { ...baseHeaders, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/app.js") {
      const js = await readFile(join(uiDirectory, "app.js"), "utf-8");
      return new Response(js, {
        status: 200,
        headers: { ...baseHeaders, "Content-Type": "application/javascript; charset=utf-8" },
      });
    }

    const staticFilePath = resolveStaticAssetPath(path, uiDirectory);
    if (staticFilePath && existsSync(staticFilePath)) {
      const content = await readFile(staticFilePath);
      const type = STATIC_CONTENT_TYPES[extname(staticFilePath).toLowerCase()] ?? "application/octet-stream";
      return new Response(content, {
        status: 200,
        headers: { ...baseHeaders, "Content-Type": type },
      });
    }

    return errorResponse(`Not found: ${path}`, 404, baseHeaders);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(message, 500, baseHeaders);
  }
}

function jsonResponse<T>(data: T, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function errorResponse(message: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  const body: ErrorResponse = { error: message };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function normalizeUrlPath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  return pathname.replace(/\/{2,}/g, "/");
}

function resolveWorkspacePath(inputPath: string, workspaceDir: string): string {
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(workspaceDir, inputPath);
  if (!isPathInside(candidate, workspaceDir)) {
    throw new Error("Requested path is outside the workspace directory");
  }
  return candidate;
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
  const candidate = resolve(candidatePath);
  const root = resolve(rootPath);
  const maybeLowerCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const maybeLowerRoot = process.platform === "win32" ? root.toLowerCase() : root;
  if (maybeLowerCandidate === maybeLowerRoot) return true;

  const separator = maybeLowerRoot.endsWith("/") || maybeLowerRoot.endsWith("\\") ? "" : process.platform === "win32" ? "\\" : "/";
  return maybeLowerCandidate.startsWith(maybeLowerRoot + separator);
}

function createSessionToken(): string {
  return randomBytes(24).toString("hex");
}

function isAuthorizedRequest(req: Request, sessionToken: string, url: URL): boolean {
  const fromHeader = req.headers.get("x-latex-review-session");
  const fromQuery = url.searchParams.get("session");
  return fromHeader === sessionToken || fromQuery === sessionToken;
}

async function parseJsonBody<T>(req: Request): Promise<T> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Expected application/json request body");
  }
  return (await req.json()) as T;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function resolveUiDirectory(): string {
  const runtimeDir = dirname(fileURLToPath(import.meta.url));
  const candidate = join(runtimeDir, "ui");
  if (!existsSync(candidate)) {
    throw new Error(`UI assets directory is missing: ${candidate}`);
  }
  return candidate;
}

function resolveStaticAssetPath(requestPath: string, uiDirectory: string): string | null {
  if (!requestPath.startsWith("/")) return null;
  const relativePath = requestPath.slice(1);
  if (!relativePath || relativePath.includes("..") || relativePath.includes("\\")) return null;
  const fullPath = resolve(uiDirectory, relativePath);
  if (!isPathInside(fullPath, uiDirectory)) return null;
  return fullPath;
}

async function maybeShowToast(
  client: ServerOptions["client"],
  message: string,
  variant: "success" | "error" | "info"
): Promise<void> {
  try {
    await client.tui?.showToast?.({ body: { message, variant } });
  } catch {
    // non-fatal
  }
}

async function enqueueCompile(pdfPath: string, state: ServerState): Promise<number> {
  if (state.compilePromise) return state.compilePromise;

  state.compilePromise = runCompile(pdfPath, state)
    .then((version) => {
      state.compilePromise = null;
      return version;
    })
    .catch((err) => {
      state.compilePromise = null;
      throw err;
    });

  return state.compilePromise;
}

async function runCompile(pdfPath: string, state: ServerState): Promise<number> {
  const pdfDir = dirname(pdfPath);
  const pdfName = pdfPath.split(/[\\/]/).pop() ?? "main.pdf";
  const texName = pdfName.replace(/\.pdf$/i, ".tex");
  const texPath = join(pdfDir, texName);
  const beforeMtime = existsSync(pdfPath) ? statSync(pdfPath).mtimeMs : 0;

  if (!existsSync(texPath)) {
    throw new Error(`Source .tex not found for PDF: ${texPath}`);
  }

  state.isCompiling = true;
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

    state.pdfVersion += 1;
    return state.pdfVersion;
  } finally {
    state.isCompiling = false;
  }
}

function formatCompileError(command: string, err: unknown): string {
  const fallback = err instanceof Error ? err.message : String(err);
  const maybe = err as { stderr?: string; stdout?: string };
  const combined = `${maybe?.stderr ?? ""}\n${maybe?.stdout ?? ""}`.trim();
  if (!combined) return `${command} failed: ${fallback}`;

  const lines = combined
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const tail = lines.slice(-12).join(" | ");
  return `${command} failed. Check main.log. ${tail}`;
}

async function findFreePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port += 1) {
    try {
      const tmp = BunRuntime?.serve({
        port,
        hostname: "127.0.0.1",
        fetch: () => new Response("ok"),
      });
      tmp.stop(true);
      return port;
    } catch {
      // try next port
    }
  }

  throw new Error(`No free port found in range ${startPort}-${startPort + 99}`);
}
