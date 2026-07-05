import type { Plugin } from "@opencode-ai/plugin";
import { join, resolve, extname, basename, dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer, type StartedServer } from "./server.ts";

const execFileAsync = promisify(execFile);
const BunRuntime = globalThis.Bun as any;

const LatexPdfReviewPlugin: Plugin = async (ctx) => {
  const runningServers = new Map<string, StartedServer>();

  return {
    config: async (cfg) => {
      cfg.command = cfg.command ?? {};
      cfg.command["latex-pdf-review"] = {
        description: "Open synchronized LaTeX ↔ PDF review viewer (SyncTeX)",
        template:
          "Open the LaTeX PDF review panel$ARGUMENTS",
      };
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "latex-pdf-review") return;

      output.parts.length = 0;

      const sessionId = input.sessionID;

      let pdfPath: string;
      try {
        pdfPath = resolvePdfPath(input.arguments?.trim() ?? "", ctx.directory);
        await validateStartupRequirements(pdfPath);
        await ensureSynctex(pdfPath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await safeShowToast(ctx.client, `latex-pdf-review: ${msg}`, "error");
        return;
      }

      const existing = runningServers.get(sessionId);
      if (existing) {
        existing.close();
        runningServers.delete(sessionId);
      }

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

      const { browserUrl } = server;
      try {
        await openBrowser(browserUrl);
      } catch {
        // non-fatal
      }

      await safeShowToast(
        ctx.client,
        `latex-pdf-review opened at ${browserUrl}`,
        "success"
      );

      try {
        await ctx.client.app.log({
          body: {
            service: "latex-pdf-review",
            level: "info",
            message: "Review session started",
            extra: { url: browserUrl, pdfPath, sessionId },
          },
        });
      } catch {
        // non-fatal
      }
    },

    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (event.type === "session.idle") {
        const sessionId = event.properties?.sessionID as string | undefined;
        if (!sessionId) return;
        const server = runningServers.get(sessionId);
        if (!server) return;

        try {
          const statusRes = await fetch(`${server.url}/api/status`, {
            headers: { "X-Latex-Review-Session": server.sessionToken },
          });
          if (!statusRes.ok) return;
          const status = (await statusRes.json()) as { isAgentBusy: boolean };
          if (!status.isAgentBusy) return;

          await fetch(`${server.url}/api/agent/busy`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Latex-Review-Session": server.sessionToken,
            },
            body: JSON.stringify({ busy: false }),
          });

          await fetch(`${server.url}/api/compile`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Latex-Review-Session": server.sessionToken,
            },
            body: "{}",
          });

          await safeShowToast(
            ctx.client,
            "Agent finished: PDF recompiled",
            "success"
          );
        } catch {
          // non-fatal
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

async function validateStartupRequirements(pdfPath: string): Promise<void> {
  if (!BunRuntime?.serve) {
    throw new Error(
      "Bun runtime is required. OpenCode plugins run on Bun, but Bun was not detected in this process."
    );
  }

  await assertCommandAvailable("bun");
  await assertCommandAvailable("synctex");

  if (!existsSync(pdfPath)) {
    throw new Error(`PDF not found: ${pdfPath}`);
  }
}

async function ensureSynctex(pdfPath: string): Promise<void> {
  const pdfName = basename(pdfPath);
  const pdfDir = dirname(pdfPath);
  const synctexGz = join(pdfDir, pdfName.replace(/\.pdf$/i, ".synctex.gz"));
  const synctex = join(pdfDir, pdfName.replace(/\.pdf$/i, ".synctex"));

  if (existsSync(synctexGz) || existsSync(synctex)) {
    // SyncTeX already available
    return;
  }

  const texName = pdfName.replace(/\.pdf$/i, ".tex");
  const texPath = join(pdfDir, texName);

  if (!existsSync(texPath)) {
    throw new Error(
      `SyncTeX data is missing for ${pdfName} and source file was not found (${texPath}). ` +
        "Compile the PDF with --synctex=1."
    );
  }

  try {
    await execFileAsync("pdflatex", ["--synctex=1", "--interaction=nonstopmode", texName], {
      cwd: pdfDir,
      timeout: 180000,
    });
    if (!existsSync(synctexGz) && !existsSync(synctex)) {
      throw new Error("pdflatex compiled but no .synctex file was generated");
    }
  } catch {
    try {
      await execFileAsync("latexmk", ["-pdf", "-synctex=1", "-interaction=nonstopmode", texName], {
        cwd: pdfDir,
        timeout: 240000,
      });
      if (!existsSync(synctexGz) && !existsSync(synctex)) {
        throw new Error("latexmk compiled but no .synctex file was generated");
      }
    } catch {
      throw new Error(
        `Could not generate SyncTeX for ${texName}. Install LaTeX tooling and compile with --synctex=1.`
      );
    }
  }
}

function resolvePdfPath(argument: string, directory: string): string {
  if (argument) {
    const candidate = resolve(directory, argument);
    if (!isPathInside(candidate, directory)) {
      throw new Error("PDF path must be inside the current workspace directory");
    }
    if (!existsSync(candidate)) {
      throw new Error(`PDF not found: ${candidate}`);
    }
    if (extname(candidate).toLowerCase() !== ".pdf") {
      throw new Error(`Not a PDF file: ${candidate}`);
    }
    return candidate;
  }

  const mainPdf = join(directory, "main.pdf");
  if (existsSync(mainPdf)) return mainPdf;

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

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  if (platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }

  if (platform === "darwin") {
    await execFileAsync("open", [url]);
    return;
  }

  if (process.env.WSL_DISTRO_NAME) {
    try {
      await execFileAsync("wslview", [url]);
      return;
    } catch {
      // fall through
    }
  }

  await execFileAsync("xdg-open", [url]);
}

async function assertCommandAvailable(command: string): Promise<void> {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(lookupCommand, [command], { timeout: 8000 });
  } catch {
    if (command === "synctex") {
      throw new Error(
        "SyncTeX was not found on PATH. Install TeX Live or MiKTeX, then verify with `synctex --version`."
      );
    }
    if (command === "bun") {
      throw new Error("Bun executable was not found on PATH. Install Bun and restart OpenCode.");
    }
    throw new Error(`Required command not found: ${command}`);
  }
}

function isPathInside(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = resolve(targetPath);
  const normalizedRoot = resolve(rootPath);
  const target = process.platform === "win32" ? normalizedTarget.toLowerCase() : normalizedTarget;
  const root = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (target === root) return true;
  const separator = root.endsWith("/") || root.endsWith("\\") ? "" : process.platform === "win32" ? "\\" : "/";
  return target.startsWith(root + separator);
}

async function safeShowToast(
  client: unknown,
  message: string,
  variant: "success" | "error" | "info" = "info"
): Promise<void> {
  if (!client || typeof client !== "object") return;
  const maybeClient = client as { tui?: { showToast?: (input: { body: { message: string; variant: string } }) => Promise<void> } };
  try {
    await maybeClient.tui?.showToast?.({ body: { message, variant } });
  } catch {
    if (variant === "error") {
      console.error(`[latex-pdf-review] ${message}`);
    }
  }
}
