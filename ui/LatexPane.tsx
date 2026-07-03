/**
 * ui/LatexPane.tsx
 *
 * Right panel: LaTeX source viewer powered by CodeMirror 6.
 *
 * Responsibilities:
 *   - Display the content of the currently resolved .tex file
 *   - Highlight the line identified by SyncTeX (forward sync)
 *   - Scroll to the highlighted line automatically
 *   - Fire onLatexLineClick() when the user clicks a line (reverse sync)
 *   - Show a breadcrumb with the current tex file path
 *
 * CodeMirror 6 is loaded via dynamic import() from CDN (esm.sh).
 * The editor is created once and updated via EditorView.dispatch()
 * when content or highlight line changes.
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useReviewState } from "./App.tsx";

// ---------------------------------------------------------------------------
// CodeMirror 6 type stubs (minimal — avoids needing @codemirror/* type packages)
// ---------------------------------------------------------------------------
interface CMExtension {
  // opaque
}

interface CMEditorState {
  doc: {
    length: number;
    line: (n: number) => { from: number; to: number };
    lineAt: (pos: number) => { from: number; to: number; number: number };
    lineNumber: (pos: number) => number;
    toString: () => string;
  };
}

interface CMEditorView {
  state: CMEditorState;
  dispatch: (...transactions: object[]) => void;
  destroy: () => void;
  scrollDOM: HTMLElement;
  dom: HTMLElement;
  posAtCoords: (coords: { x: number; y: number }) => number | null;
  lineBlockAt: (pos: number) => { from: number; to: number; top: number; bottom: number };
}

interface CMEditorViewClass {
  new (config: { state: object; parent: HTMLElement }): CMEditorView;
  updateListener: {
    of: (fn: (update: { transactions: object[]; docChanged?: boolean; state?: CMEditorState }) => void) => CMExtension;
  };
  theme: (spec: object, opts?: object) => CMExtension;
  editorAttributes: (attrs: object) => CMExtension;
  lineNumbers: () => CMExtension;
  highlightActiveLineGutter?: () => CMExtension;
  highlightActiveLine?: () => CMExtension;
}

interface CMModule {
  EditorView: CMEditorViewClass;
  EditorState: {
    create: (config: { doc: string; extensions: CMExtension[] }) => object;
  };
  StateEffect: { define: <T>() => { of: (value: T) => object } };
  StateField: {
    define: <T>(config: {
      create: () => T;
      update: (value: T, tr: object) => T;
    }) => CMExtension & { init: (fn: () => T) => CMExtension };
  };
  Decoration: {
    line: (attrs: object) => unknown;
    mark: (attrs: object) => unknown;
    set: (decorations: object[], sorted?: boolean) => unknown;
    none: unknown;
  };
  DecorationSet: unknown;
  lineNumbers: () => CMExtension;
  highlightActiveLineGutter: () => CMExtension;
  highlightActiveLine: () => CMExtension;
  syntaxHighlighting: (theme: object) => CMExtension;
  defaultHighlightStyle?: object;
}

// CDN imports for CodeMirror 6 (ESM builds via esm.sh)
// Using a single bundled entry point to avoid duplicate state instances
const CM_BUNDLE_CDN = "https://esm.sh/@codemirror/basic-setup@0?bundle";

// ---------------------------------------------------------------------------
// Dark theme for CodeMirror (matches the overall UI palette)
// ---------------------------------------------------------------------------
const DARK_THEME_SPEC = {
  "&": {
    color: "#e6edf3",
    backgroundColor: "#0d1117",
  },
  ".cm-content": { caretColor: "#e6edf3" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#e6edf3" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "#264f78",
  },
  ".cm-panels": { backgroundColor: "#161b22", color: "#e6edf3" },
  ".cm-button": {
    backgroundImage: "linear-gradient(#21262d, #161b22)",
    border: "1px solid #30363d",
    color: "#e6edf3",
  },
  ".cm-activeLine": { backgroundColor: "#161b2266" },
  ".cm-gutters": {
    backgroundColor: "#0d1117",
    color: "#3d444d",
    border: "none",
    borderRight: "1px solid #21262d",
  },
  ".cm-activeLineGutter": { backgroundColor: "#161b22" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 4px" },
};

// ---------------------------------------------------------------------------
// Helper: load CodeMirror lazily
// ---------------------------------------------------------------------------
let cmPromise: Promise<CMModule> | null = null;

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

async function loadCodeMirror(): Promise<CMModule> {
  if (cmPromise) {
    console.log("[LatexPane] Returning cached CodeMirror promise");
    return cmPromise;
  }
  console.log("[LatexPane] Starting CodeMirror load from CDN");
  cmPromise = (async () => {
    try {
      console.log("[LatexPane] Loading @codemirror/basic-setup from single bundle");
      const module = await import(CM_BUNDLE_CDN);
      console.log("[LatexPane] Loaded CodeMirror bundle", module);
      
      const merged = module as CMModule;
      console.log("[LatexPane] CodeMirror merged modules keys:", Object.keys(merged).slice(0, 10));
      console.log("[LatexPane] CodeMirror loaded successfully");
      return merged;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[LatexPane] Failed to load CodeMirror:", msg, err);
      throw err;
    }
  })();
  return cmPromise;
}

// ---------------------------------------------------------------------------
// SyncTeX highlight decoration
// ---------------------------------------------------------------------------

/**
 * Apply a line decoration to the editor for the SyncTeX-highlighted line.
 * Returns a dispatch transaction spec.
 */
function buildHighlightTransaction(
  view: CMEditorView,
  targetLine: number | null
): object | null {
  if (targetLine === null) return null;
  try {
    const line = view.state.doc.line(targetLine);
    return {
      effects: [],
      // We use a simple selection move + scrollIntoView instead of
      // a decoration state field for MVP simplicity.
      selection: { anchor: line.from },
      scrollIntoView: true,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LatexPane component
// ---------------------------------------------------------------------------

export function LatexPane() {
  const {
    texContent,
    texFilePath,
    syncHighlight,
    onLatexLineClick,
    onLatexCursorLineChange,
    onSaveTex,
    isSavingTex,
    isCompiling,
    isAgentBusy,
    isUiLocked,
  } = useReviewState();

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CMEditorView | null>(null);
  const cmRef = useRef<CMModule | null>(null);
  const texFileRef = useRef(texFilePath);
  const isUiLockedRef = useRef(isUiLocked);
  const onLatexLineClickRef = useRef(onLatexLineClick);
  const onLatexCursorLineChangeRef = useRef(onLatexCursorLineChange);
  const programmaticChangeRef = useRef(false);
  const [cmLoaded, setCmLoaded] = useState(false);
  const [cmError, setCmError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<{clickY: number; line: number; texFile: string} | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const lastCursorLineRef = useRef<number | null>(null);
  texFileRef.current = texFilePath;
  isUiLockedRef.current = isUiLocked;
  onLatexLineClickRef.current = onLatexLineClick;
  onLatexCursorLineChangeRef.current = onLatexCursorLineChange;

  // ── Create editor on mount ─────────────────────────────────────────────
  useEffect(() => {
    console.log("[LatexPane] useEffect: mount hook fired");
    
    // Use a small timeout to ensure the DOM is fully updated and ref is attached
    const timeout = setTimeout(async () => {
      if (!containerRef.current) {
        console.log("[LatexPane] containerRef.current is null, skipping");
        return;
      }

      try {
        console.log("[LatexPane] Starting loadCodeMirror...");
        const cm = await loadCodeMirror();
        
        if (!containerRef.current) {
          return;
        }
        
        cmRef.current = cm;

        if (!cm.EditorView || !cm.EditorState) {
          throw new Error("CodeMirror modules missing EditorView or EditorState");
        }

        console.log("[LatexPane] Creating dark theme...");
        const darkTheme = cm.EditorView.theme(DARK_THEME_SPEC, { dark: true });

        const extensions: CMExtension[] = [
          darkTheme,
          ...(cm.lineNumbers ? [cm.lineNumbers()] : []),
          ...(cm.highlightActiveLine ? [cm.highlightActiveLine()] : []),
          ...(cm.highlightActiveLineGutter ? [cm.highlightActiveLineGutter()] : []),
          cm.EditorView.updateListener.of((update) => {
            if (update.docChanged && !programmaticChangeRef.current) {
              setIsDirty(true);
            }

            if (isUiLockedRef.current || !update.state) {
              return;
            }

            const state = update.state as CMEditorState & {
              selection?: { main?: { head?: number } };
            };
            const head = state.selection?.main?.head;
            if (typeof head !== "number") return;
            const line = state.doc.lineAt(head);
            const lineNumber = line.number;
            if (lastCursorLineRef.current === lineNumber) {
              return;
            }
            lastCursorLineRef.current = lineNumber;
            onLatexCursorLineChangeRef.current(lineNumber, texFileRef.current);
          }),
        ];

        console.log("[LatexPane] Creating EditorState with doc length:", texContent?.length ?? 0);
        const state = cm.EditorState.create({
          doc: texContent || "",
          extensions,
        });

        console.log("[LatexPane] Creating EditorView...");
        const view = new cm.EditorView({ state, parent: containerRef.current });
        editorRef.current = view;
        console.log("[LatexPane] EditorView created successfully");
        setCmLoaded(true);

        // Attach click listener for line clicks (reverse sync)
        const listener = (e: MouseEvent) => {
          const target = e.target as HTMLElement;
          
          // Only process clicks on the editor content area, not the gutter
          if (target.classList?.contains("cm-gutterElement") || target.closest(".cm-gutter")) {
            return;
          }

          try {
            // Get click position in viewport coordinates
            const viewportY = (e as MouseEvent).clientY;
            
            // Use CodeMirror's posAtCoords to get the exact position
            // Coordinates should be relative to the editor viewport
            const pos = view.posAtCoords({ x: 0, y: viewportY });
            
            if (pos === null) {
              return;
            }
            
            // Convert position to line number
            const line = view.state.doc.lineAt(pos);
            const lineNumber = line.number;
            
            // Get total number of lines in document
            // const totalLines = view.state.doc.lines;
            
            // Invert the line number: map from the bottom
            // const invertedLine = totalLines - lineNumber + 1;
            
            // Store debug info
            setDebugInfo({
              clickY: (e as MouseEvent).clientY,
              line: lineNumber,
              texFile: texFileRef.current
            });
            
            if (!isUiLockedRef.current) {
              onLatexLineClickRef.current(lineNumber, texFileRef.current);
            }
          } catch (err) {
            console.error("[LatexPane] Error processing click:", err);
          }
        };
        
        view.scrollDOM.addEventListener("mousedown", listener, true);
        
        console.log("[LatexPane] Initialization complete, editor ready");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[LatexPane] Initialization error:", msg, err);
        setCmError(msg);
      }
    }, 0);

    return () => {
      clearTimeout(timeout);
      console.log("[LatexPane] Cleanup: destroying editor");
      if (editorRef.current) {
        editorRef.current.destroy();
        editorRef.current = null;
      }
    };
    // Only run once on mount — content updates happen via dispatch below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Update editor content when texContent changes ──────────────────────
  useEffect(() => {
    const view = editorRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc === texContent) return;

    const previousScrollTop = view.scrollDOM.scrollTop;
    programmaticChangeRef.current = true;
    view.dispatch({
      changes: { from: 0, to: currentDoc.length, insert: texContent },
    });
    programmaticChangeRef.current = false;
    view.scrollDOM.scrollTop = previousScrollTop;
    setIsDirty(false);
  }, [texContent]);

  const saveCurrentDocument = useCallback(async () => {
    const view = editorRef.current;
    if (!view || !texFileRef.current || isUiLocked || isSavingTex || !isDirty) return;
    const content = view.state.doc.toString();
    try {
      await onSaveTex(content);
      setIsDirty(false);
    } catch {
      // onSaveTex already surfaces the error in App state
    }
  }, [isDirty, isSavingTex, isUiLocked, onSaveTex]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveCurrentDocument();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveCurrentDocument]);

  useEffect(() => {
    if (!isUiLocked) return;
    const view = editorRef.current;
    if (!view) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && view.dom.contains(active)) {
      active.blur();
    }
  }, [isUiLocked]);

  // ── Scroll to + highlight the SyncTeX line ─────────────────────────────
  useEffect(() => {
    const view = editorRef.current;
    if (!view || !syncHighlight) return;

    const targetLine = syncHighlight.texLine;
    
    // Scroll and move cursor to the target line
    const tx = buildHighlightTransaction(view, targetLine);
    if (tx) view.dispatch(tx);

    // Apply bright visual highlight
    setTimeout(() => {
      const lineEls = view.dom.querySelectorAll(".cm-line");
      lineEls.forEach((el, i) => {
        el.classList.remove("cm-synctex-highlight");
      });
      
      // Find and highlight the exact line
      if (lineEls[targetLine - 1]) {
        const lineEl = lineEls[targetLine - 1] as HTMLElement;
        lineEl.classList.add("cm-synctex-highlight");
        
        // Make sure it's visible
        lineEl.style.position = "relative";
        lineEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 50);
  }, [syncHighlight]);

  // ── Derive the short filename for the breadcrumb ──────────────────────
  const texFileName = texFilePath
    ? texFilePath.split(/[\\/]/).pop() ?? texFilePath
    : null;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      <div className="pane-header">
        LaTeX Source
        {texFileName && (
          <span
            className="latex-file-badge"
            title={texFilePath}
          >
            {texFileName}
          </span>
        )}
        {syncHighlight && (
          <span style={{ marginLeft: "auto", fontSize: 10, color: "#ffd700", fontFamily: "monospace", fontWeight: "bold" }}>
            line {syncHighlight.texLine} selected
          </span>
        )}
        <button
          onClick={() => {
            void saveCurrentDocument();
          }}
          disabled={!isDirty || isSavingTex || isCompiling || isAgentBusy}
          style={{
            marginLeft: 8,
            padding: "2px 8px",
            fontSize: 11,
            background: isDirty ? "#1f6feb" : "#30363d",
            border: "1px solid #30363d",
            color: "#e6edf3",
            borderRadius: 4,
            cursor: !isDirty || isSavingTex || isCompiling || isAgentBusy ? "default" : "pointer",
            opacity: !isDirty || isSavingTex || isCompiling || isAgentBusy ? 0.6 : 1,
          }}
          title="Save LaTeX file (Ctrl+S)"
        >
          {isSavingTex ? "Saving..." : "Save"}
        </button>
      </div>

      <div style={{ position: "relative", height: "100%", overflow: "hidden" }}>
        {cmError && (
          <div style={{
            padding: "12px",
            background: "#2d1a1a",
            border: "1px solid #f78166",
            color: "#f78166",
            fontSize: "11px",
            margin: "8px",
            borderRadius: "4px",
          }}>
            CodeMirror error: {cmError}
          </div>
        )}
        
        <div
          ref={containerRef}
          className="codemirror-wrapper"
          style={{ height: cmError ? "calc(100% - 50px)" : "100%" }}
        />

        {!cmLoaded && !cmError && (
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.3)",
            zIndex: 10,
          }}>
            <div style={{ color: "#8b949e", fontSize: "12px" }}>
              {texContent ? "Loading editor…" : "Click somewhere in the PDF to load the LaTeX source"}
            </div>
          </div>
        )}

        {isUiLocked && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0, 0, 0, 0.25)",
              zIndex: 20,
              pointerEvents: "all",
            }}
          />
        )}

        {debugInfo && (
          <div style={{
            position: "absolute",
            bottom: 10,
            right: 10,
            padding: "8px 12px",
            background: "#1f2937",
            border: "1px solid #4b5563",
            color: "#a0aec0",
            fontSize: "11px",
            fontFamily: "monospace",
            borderRadius: "4px",
            zIndex: 100,
            whiteSpace: "nowrap",
          }}>
            Click Y: {debugInfo.clickY.toFixed(0)} | Line: {debugInfo.line} | File: {debugInfo.texFile.split(/[\\/]/).pop()}
          </div>
        )}
      </div>
    </>
  );
}
