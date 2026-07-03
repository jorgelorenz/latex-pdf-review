# latex-pdf-review

An OpenCode plugin for PDF ↔ LaTeX synchronized review using SyncTeX.

Review your compiled LaTeX document in a split-pane browser UI: click anywhere in the PDF to jump to the corresponding source line, write a comment, and let the OpenCode agent apply a minimal unified diff.

---

## How It Works

```
/latex-pdf-review
       │
       ▼
Split-pane browser UI opens automatically
┌───────────────────┬────────────────────┐
│     PDF Viewer    │   LaTeX Source     │
│  (click to sync)  │  (line highlight)  │
│                   │                    │
│  [annotation pin] │  > line 45: text   │
└───────────────────┴────────────────────┘
       │                    │
    Click ──── SyncTeX ──▶  highlight
               (synctex edit)
               
               LaTeX click ─▶ SyncTeX ─▶ PDF highlight
               (synctex view)
               
                Write comment → Submit
                        │
                        ▼
              OpenCode agent receives:
              "You are editing LaTeX…
               COMMENT: …
               LATEX CONTEXT: ±40 lines
               Return ONLY a unified diff."
                        │
                        ▼
              Agent returns unified diff
              Apply with: patch -p1 < diff.patch
```

---

## Prerequisites

### 1. SyncTeX on PATH

SyncTeX ships with every major LaTeX distribution:

- **TeX Live** (Linux/macOS/WSL):
  ```bash
  # Typically already included. Verify:
  synctex --version
  
  # If missing:
  sudo apt install texlive-base        # Debian/Ubuntu
  brew install texlive                  # macOS (Homebrew)
  ```

- **MiKTeX** (Windows):
  ```cmd
  # SyncTeX is included. Verify:
  synctex --version
  
  # If missing, via MiKTeX Console → Packages → install synctex
  ```

- **WSL** (Windows Subsystem for Linux):
  ```bash
  sudo apt install texlive-base
  ```

### 2. Compile with SyncTeX enabled

Your PDF **must** be compiled with SyncTeX to use this plugin:

```bash
# pdflatex
pdflatex --synctex=1 main.tex

# latexmk (recommended — handles multi-pass automatically)
latexmk -pdf -synctex=1 main.tex

# lualatex
lualatex --synctex=1 main.tex
```

This produces `main.synctex.gz` alongside `main.pdf`. Both files must be present.

### 3. Bun runtime

OpenCode plugins run on Bun. This plugin uses the Bun native HTTP server.

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
```

### 4. OpenCode

```bash
npm install -g opencode-ai
```

---

## Installation

### Option A — This repository (already wired)

This plugin is already installed in this repository. The following files were created:

```
.opencode/
  commands/
    latex-pdf-review.md    ← registers the /latex-pdf-review slash command
  plugins/
    latex-pdf-review.ts    ← thin loader that delegates to plugins/

plugins/
  latex-pdf-review/        ← the plugin package (independent)
    plugin.ts
    server.ts
    types.ts
    core/
      synctex.ts
      reverseSync.ts
      context.ts
      prompt.ts
    ui/
      index.html
      App.tsx
      SplitView.tsx
      PdfPane.tsx
      LatexPane.tsx
    package.json
    README.md

opencode.json              ← workspace config (minimal, just the schema)
```

Just open OpenCode in this directory and run `/latex-pdf-review`.

### Option B — Install in another project

Copy the plugin into your project:

```bash
# From this repository root:
cp -r plugins/latex-pdf-review /path/to/your/project/plugins/
mkdir -p /path/to/your/project/.opencode/commands
mkdir -p /path/to/your/project/.opencode/plugins
cp .opencode/commands/latex-pdf-review.md /path/to/your/project/.opencode/commands/
cp .opencode/plugins/latex-pdf-review.ts /path/to/your/project/.opencode/plugins/
```

Then adjust the import path in `.opencode/plugins/latex-pdf-review.ts` if needed.

### Option C — Global install (all projects)

Copy the command and plugin loader to your global OpenCode config:

```bash
# macOS/Linux
cp .opencode/commands/latex-pdf-review.md ~/.config/opencode/commands/
cp .opencode/plugins/latex-pdf-review.ts ~/.config/opencode/plugins/
```

For the loader to work globally, either:
- Use an absolute path in the `import` statement, or
- Publish the plugin to npm and reference it in `opencode.json`

---

## Usage

### Basic usage

```
/latex-pdf-review
```

Auto-detects `main.pdf` in the current directory. Opens the review UI in your browser.

### Specify a PDF

```
/latex-pdf-review chapters/chapter1.pdf
```

### What happens

1. The browser opens with a split-pane UI
2. The **left pane** shows your PDF
3. Click anywhere in the PDF
4. SyncTeX maps the click to a `.tex` file + line number
5. The **right pane** loads the `.tex` file and scrolls to that line (highlighted in amber)
6. Write your review comment in the text area at the bottom right
7. Press **Submit Review** (or Ctrl+Enter)
8. The plugin injects this exact prompt into the OpenCode session:

```
You are editing LaTeX from a PDF review session.
Apply minimal changes only.

COMMENT:
<your comment>

LATEX CONTEXT:
  ...
> 45 | the selected line
  46 | next line
  ...

Return ONLY a unified diff.
```

9. The OpenCode agent responds with a unified diff
10. Apply it: `patch -p1 < the-diff.patch` or ask the agent to apply it directly

### Reverse sync (LaTeX → PDF)

Click any line in the **LaTeX pane** to highlight the corresponding region in the PDF. This uses `synctex view` and is best-effort (comment lines and macro definitions may not have a PDF match).

### Annotation pins

Every submitted annotation leaves a colored dot on the PDF at the click location:
- Orange dot = pending (comment written but not submitted)
- Green dot = submitted to agent

Click a dot to re-select that annotation and see its location in the LaTeX pane.

---

## Architecture

```
plugins/latex-pdf-review/
├── plugin.ts          OpenCode command hook (command.execute.before)
│                      Resolves PDF path, starts local server, opens browser
├── server.ts          Bun HTTP server
│                      Routes: /api/config, /api/file, /api/synctex/edit,
│                              /api/synctex/view, /api/review/submit,
│                              /api/annotations, /pdf (binary)
├── types.ts           Annotation, SyncResult, ReverseSyncResult, ReviewState
├── core/
│   ├── synctex.ts     Wraps: synctex edit -o <pdf>:<page>:<x>:<y>
│   ├── reverseSync.ts Wraps: synctex view -i <line>:1:<tex> -o <pdf>
│   ├── context.ts     Reads .tex file, returns ±40 lines around target
│   └── prompt.ts      Builds the strict agent prompt
└── ui/
    ├── index.html     Shell HTML with importmap (React, no bundler needed)
    ├── App.tsx        Root state orchestrator (ReviewStateContext pattern)
    ├── SplitView.tsx  Layout: header + resizable PDF/LaTeX split + comments
    ├── PdfPane.tsx    PDF.js canvas viewer + click → SyncTeX + pin overlays
    └── LatexPane.tsx  CodeMirror 6 viewer + line highlighting + click handler
```

### State management

Adapted from the [Plannotator](https://plannotator.ai) review-editor architecture:

| Pattern | Description |
|---|---|
| `command.execute.before` | Intercepts `/latex-pdf-review`, suppresses `.md` body from agent |
| Dual context split | `ReviewStateContext` (annotation/sync state) + `SyncLoadingContext` (high-freq loading flag) |
| Mirror refs | `syncHighlightRef.current = syncHighlight` prevents stale closures in async event handlers |
| Two-phase annotation | `pendingAnnotation` (before comment) → `savedAnnotation` (after submit) |

### SyncTeX data flow

```
User clicks PDF canvas
  → Canvas pixel coords → PDF user-space coords (via viewport.transform)
  → POST /api/synctex/edit { pdfFile, page, x, y }
  → server: synctex edit -o main.pdf:3:156:234
  → stdout: "Input:/path/main.tex\nLine:45\nColumn:7"
  → { texFile: "/path/main.tex", texLine: 45, texColumn: 7 }
  → UI: load tex file, scroll CodeMirror to line 45, highlight it

User clicks LaTeX line
  → POST /api/synctex/view { texFile, line, pdfFile }
  → server: synctex view -i 45:1:/path/main.tex -o main.pdf
  → stdout: "Page:3\nh:156.789\nv:234.456\nW:200\nH:12"
  → { page: 3, x: 156, y: 234, width: 200, height: 12 }
  → UI: draw highlight overlay on PDF canvas at page 3, position (156, 234)
```

### Review submission flow

```
User writes comment + clicks Submit
  → POST /api/review/submit { annotation }
  → server:
      1. readFile(texFile)                          // read .tex
      2. extractLatexContext(texFile, texLine, 40)  // ±40 lines
      3. buildAnnotationPrompt(annotation, context) // strict prompt
      4. client.session.prompt({                    // inject into OpenCode
           parts: [{ type: "text", text: prompt }]
         })
  → OpenCode agent receives the prompt and responds with a unified diff
  → diff shown in OpenCode TUI
```

---

## Troubleshooting

### "synctex binary not found on PATH"

Install synctex via your LaTeX distribution (see Prerequisites above).

### "No SyncTeX data" / reverse sync not working

- Make sure you compiled with `--synctex=1`
- The `main.synctex.gz` file must be in the same directory as `main.pdf`
- Some lines (comments, macro definitions) have no PDF box and will return null

### PDF not loading in browser

- The server starts on a random port between 7200–7299
- Check the OpenCode TUI toast for the exact URL
- Make sure no firewall is blocking localhost connections

### Agent not responding after submit

- Check the OpenCode TUI — the prompt is injected directly into the current session
- The agent may need a moment to process; it will respond in the TUI as usual

---

## Development

```bash
cd plugins/latex-pdf-review

# Install deps
bun install

# Type-check
bun run type-check

# Build the UI bundle (optional — Bun transpiles on-the-fly in dev)
bun run build:ui
```

To test the server in isolation (without the full OpenCode plugin context):

```bash
# Start with a mock client
bun run --hot server.ts
```

---

## License

MIT
