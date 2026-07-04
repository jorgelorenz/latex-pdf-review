/**
 * ui/App.tsx
 *
 * Root state orchestrator for the latex-pdf-review split UI.
 *
 * Architecture follows the plannotator ReviewApp pattern:
 *   - Single component owns ALL state
 *   - Two contexts split by update frequency:
 *       ReviewStateContext  — annotation / sync state (user-triggered updates)
 *       SyncLoadingContext  — high-freq loading flag during synctex calls
 *   - Mirror refs for stale-closure safety (same pattern as plannotator's
 *     isAllFilesActiveRef etc.)
 *   - Handlers passed down via context, not prop-drilling
 *
 * The component is exported as a factory function `initApp(root)` so it
 * can be called from the <script type="module"> in index.html.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  Annotation,
  ConfigResponse,
  SyncResult,
  ReverseSyncResult,
  ReviewState,
  FileSaveResponse,
  RecompileResponse,
  UiStatusResponse,
} from "../types.ts";
import { SplitView } from "./SplitView.tsx";

const REVERSE_SYNC_ENABLED = false;

// ---------------------------------------------------------------------------
// Contexts (split by update frequency — plannotator pattern)
// ---------------------------------------------------------------------------

/** Low-frequency context: annotation state + sync results + handlers */
export interface ReviewStateContextValue extends ReviewState {
  // Handlers
  onPdfClick: (
    page: number,
    x: number,
    y: number,
    selectedText?: string,
    synctexY?: number
  ) => void;
  onLatexLineClick: (line: number, texFile: string) => void;
  onLatexCursorLineChange: (line: number, texFile: string) => void;
  onCommentChange: (comment: string) => void;
  onAddAnnotation: () => void; // Submit pending annotation to queue
  onEditAnnotation: (id: string, comment: string) => void; // Edit a pending annotation
  onDeleteAnnotation: (id: string) => void; // Delete a pending annotation
  onSubmitAll: () => void; // Submit all pending annotations to agent
  onSaveTex: (content: string) => Promise<void>;
  onSelectAnnotation: (id: string | null) => void;
  onCloseWithoutSubmit: () => void; // Close tab without submitting
  // Pending annotations queue
  pendingAnnotations: Annotation[]; // Queue of pending annotations
  currentPendingComment: string; // Comment being typed for current selection
  submitStatus: "idle" | "ok" | "error";
  submitError: string | null;
}

const ReviewStateContext = createContext<ReviewStateContextValue | null>(null);

export function useReviewState(): ReviewStateContextValue {
  const ctx = useContext(ReviewStateContext);
  if (!ctx) throw new Error("useReviewState must be used inside ReviewStateProvider");
  return ctx;
}

/** High-frequency context: only the syncing loading flag */
export interface SyncLoadingContextValue {
  isSyncing: boolean;
}
const SyncLoadingContext = createContext<SyncLoadingContextValue>({ isSyncing: false });
export function useSyncLoading(): SyncLoadingContextValue {
  return useContext(SyncLoadingContext);
}

// ---------------------------------------------------------------------------
// Utility: generate short IDs (mirrors plannotator's generateId.ts)
// ---------------------------------------------------------------------------
function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const sessionToken = new URLSearchParams(window.location.search).get("session");
  const headers = new Headers(opts?.headers ?? {});
  if (sessionToken) {
    headers.set("X-Latex-Review-Session", sessionToken);
  }

  const res = await fetch(path, { ...opts, headers });
  const json = await res.json();
  if (!res.ok) throw new Error((json as { error?: string }).error ?? res.statusText);
  return json as T;
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

function App() {
  // ── Config ─────────────────────────────────────────────────────────────
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  // ── LaTeX file content ──────────────────────────────────────────────────
  const [texContent, setTexContent] = useState("");
  const [texFilePath, setTexFilePath] = useState("");

  // ── Annotations ─────────────────────────────────────────────────────────
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);

  // ── Sync highlights ──────────────────────────────────────────────────────
  const [syncHighlight, setSyncHighlight] = useState<SyncResult | null>(null);
  const [reverseSyncHighlight, setReverseSyncHighlight] = useState<ReverseSyncResult | null>(null);

  // ── Loading flags ────────────────────────────────────────────────────────
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSavingTex, setIsSavingTex] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);
  const [isAgentBusy, setIsAgentBusy] = useState(false);
  const [pdfVersion, setPdfVersion] = useState(1);
  const [cursorDrivenLine, setCursorDrivenLine] = useState<number | null>(null);

  // ── Pending annotation state ─────────────────────────────────────────────
  const [pendingAnnotations, setPendingAnnotations] = useState<Annotation[]>([]); // Queue
  const [currentPendingComment, setCurrentPendingComment] = useState(""); // Comment for new selection
  const [currentSelection, setCurrentSelection] = useState<Annotation | null>(null); // Current PDF/LaTeX click

  // ── Submit status ────────────────────────────────────────────────────────
  const [submitStatus, setSubmitStatus] = useState<"idle" | "ok" | "error">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Non-fatal errors ─────────────────────────────────────────────────────
  const [lastError, setLastError] = useState<string | null>(null);

  // ── Mirror refs (plannotator stale-closure pattern) ──────────────────────
  const syncHighlightRef = useRef<SyncResult | null>(null);
  syncHighlightRef.current = syncHighlight;
  const annotationsRef = useRef<Annotation[]>([]);
  annotationsRef.current = annotations;
  const pendingAnnotationsRef = useRef<Annotation[]>([]);
  pendingAnnotationsRef.current = pendingAnnotations;
  const previousAgentBusyRef = useRef(false);

  const refreshActiveTexFile = useCallback(async () => {
    if (!texFilePath) return;
    try {
      const fileResp = await apiFetch<{ path: string; content: string }>(
        `/api/file?path=${encodeURIComponent(texFilePath)}`
      );
      setTexContent(fileResp.content);
      setTexFilePath(fileResp.path);
    } catch {
      // Non-fatal
    }
  }, [texFilePath]);

  // ── Load config on mount ─────────────────────────────────────────────────
  useEffect(() => {
    apiFetch<ConfigResponse>("/api/config")
      .then(setConfig)
      .catch((e) => setConfigError(e.message));
  }, []);

  // ── Load saved annotations from server ──────────────────────────────────
  useEffect(() => {
    apiFetch<Annotation[]>("/api/annotations")
      .then(setAnnotations)
      .catch(() => {/* non-fatal */});
  }, []);

  // ── Poll server status (agent busy + compile state + pdf version) ───────
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await apiFetch<UiStatusResponse>("/api/status");
        if (cancelled) return;
        const wasAgentBusy = previousAgentBusyRef.current;
        previousAgentBusyRef.current = status.isAgentBusy;
        setIsCompiling(status.isCompiling);
        setIsAgentBusy(status.isAgentBusy);
        setPdfVersion((prev) => (status.pdfVersion > prev ? status.pdfVersion : prev));

        if (wasAgentBusy && !status.isAgentBusy) {
          await refreshActiveTexFile();
        }
      } catch {
        // Non-fatal polling error
      }
    };

    const interval = window.setInterval(poll, 1500);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshActiveTexFile]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  /**
   * Called when user clicks in the PDF pane.
   * 1. Calls POST /api/synctex/edit to get LaTeX location
   * 2. Loads the .tex file if it changed
   * 3. Sets syncHighlight → LatexPane scrolls to that line
   * 4. Creates a pending annotation (waiting for the user to add a comment)
   */
  const onPdfClick = useCallback(
    async (
      page: number,
      x: number,
      y: number,
      selectedText?: string,
      synctexY?: number
    ) => {
      if (!config || isSavingTex || isCompiling || isAgentBusy) return;
      setIsSyncing(true);
      setLastError(null);

      try {
        const result = await apiFetch<SyncResult>("/api/synctex/edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pdfFile: config.pdfPath,
            page,
            x,
            y: synctexY ?? y,
          }),
        });

        setSyncHighlight(result);

        // Load .tex content if it changed
        if (result.texFile !== texFilePath) {
          const fileResp = await apiFetch<{ path: string; content: string }>(
            `/api/file?path=${encodeURIComponent(result.texFile)}`
          );
          setTexContent(fileResp.content);
          setTexFilePath(fileResp.path);
        }

        // Create a pending annotation (no comment yet)
        const selection: Annotation = {
          id: generateId(),
          pdfFile: config.pdfPath,
          page,
          bbox: [x, y],
          coordOrigin: "pdf",
          selectedText,
          comment: "",
          texFile: result.texFile,
          texLine: result.texLine,
          createdAt: Date.now(),
          reviewStatus: "pending",
        };
        setCurrentSelection(selection);
        setCurrentPendingComment("");
        setSubmitStatus("idle");
        setSubmitError(null);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(msg);
      } finally {
        setIsSyncing(false);
      }
    },
    [config, texFilePath, isSavingTex, isCompiling, isAgentBusy]
  );

  /**
    * Called when user clicks a line in the LaTeX pane.
    * 1. Runs reverse SyncTeX to highlight the corresponding PDF region
    * 2. Creates a pending annotation for the user to add a comment
    */
   const onLatexLineClick = useCallback(
     async (line: number, texFile: string) => {
       if (!config || isSavingTex || isCompiling || isAgentBusy) return;

       if (!REVERSE_SYNC_ENABLED) {
         setSyncHighlight({ texFile, texLine: line, texColumn: 0 });
         const selection: Annotation = {
           id: generateId(),
           pdfFile: config.pdfPath,
           page: 1,
           bbox: [0, 0],
           coordOrigin: "pdf",
           selectedText: undefined,
           comment: "",
           texFile,
           texLine: line,
           createdAt: Date.now(),
           reviewStatus: "pending",
         };
         setCurrentSelection(selection);
         setCurrentPendingComment("");
         setSubmitStatus("idle");
         setSubmitError(null);
         setReverseSyncHighlight(null);
         return;
       }

       setIsSyncing(true);
       setLastError(null);

       try {
         const result = await apiFetch<ReverseSyncResult | null>(
           "/api/synctex/view",
           {
             method: "POST",
             headers: { "Content-Type": "application/json" },
             body: JSON.stringify({
               texFile,
               line,
               pdfFile: config.pdfPath,
             }),
           }
         );
         // null means no match — silently clear the highlight
         setReverseSyncHighlight(result);

         // Create a pending annotation for this LaTeX line click
         // If reverse sync found a PDF location, use it; otherwise use a default
          const selection: Annotation = {
            id: generateId(),
            pdfFile: config.pdfPath,
            page: result?.page ?? 1,
            bbox: result ? [result.x, result.y] : [0, 0],
            coordOrigin: result?.origin ?? "pdf",
            selectedText: undefined,
            comment: "",
            texFile,
            texLine: line,
           createdAt: Date.now(),
           reviewStatus: "pending",
         };
         
         setCurrentSelection(selection);
         setCurrentPendingComment("");
         setSubmitStatus("idle");
         setSubmitError(null);
         
         // Also update syncHighlight to show the LaTeX line
         setSyncHighlight({ texFile, texLine: line, texColumn: 0 });
       } catch (err: unknown) {
         const msg = err instanceof Error ? err.message : String(err);
         setLastError(msg);
       } finally {
         setIsSyncing(false);
       }
     },
     [config, isSavingTex, isCompiling, isAgentBusy]
   );

  /** Update the current pending comment text */
  const onCommentChange = useCallback((comment: string) => {
    setCurrentPendingComment(comment);
    setSubmitStatus("idle");
  }, []);

  const onLatexCursorLineChange = useCallback(
    (line: number, texFile: string) => {
      if (!config || !texFile || line <= 0) return;
      setCursorDrivenLine(line);
      setCurrentSelection((prev) => {
        if (prev) {
          return {
            ...prev,
            texFile,
            texLine: line,
          };
        }
        return {
          id: generateId(),
          pdfFile: config.pdfPath,
          page: reverseSyncHighlight?.page ?? 1,
          bbox: reverseSyncHighlight
            ? [reverseSyncHighlight.x, reverseSyncHighlight.y]
            : [0, 0],
          coordOrigin: reverseSyncHighlight?.origin ?? "pdf",
          selectedText: undefined,
          comment: "",
          texFile,
          texLine: line,
          createdAt: Date.now(),
          reviewStatus: "pending",
        };
      });
    },
    [config, reverseSyncHighlight]
  );

  useEffect(() => {
    if (!cursorDrivenLine || !texFilePath || !config) return;
    if (isSavingTex || isCompiling || isAgentBusy) return;
    if (!REVERSE_SYNC_ENABLED) {
      setSyncHighlight((prev) => {
        if (prev && prev.texFile === texFilePath && prev.texLine === cursorDrivenLine) {
          return prev;
        }
        return { texFile: texFilePath, texLine: cursorDrivenLine, texColumn: 0 };
      });
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const result = await apiFetch<ReverseSyncResult | null>(
          "/api/synctex/view",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              texFile: texFilePath,
              line: cursorDrivenLine,
              pdfFile: config.pdfPath,
            }),
          }
        );
        if (cancelled) return;
        setSyncHighlight((prev) => {
          if (
            prev &&
            prev.texFile === texFilePath &&
            prev.texLine === cursorDrivenLine
          ) {
            return prev;
          }
          return { texFile: texFilePath, texLine: cursorDrivenLine, texColumn: 0 };
        });
        if (result) {
          setReverseSyncHighlight((prev) => {
            if (
              prev &&
              prev.page === result.page &&
              prev.x === result.x &&
              prev.y === result.y &&
              prev.width === result.width &&
              prev.height === result.height
            ) {
              return prev;
            }
            return result;
          });
        }
      } catch {
        // non-fatal
      }
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [
    cursorDrivenLine,
    texFilePath,
    config,
    isSavingTex,
    isCompiling,
    isAgentBusy,
  ]);

  /**
   * Add the current pending annotation to the queue (with comment).
   * This lets the user keep adding more annotations.
   */
  const onAddAnnotation = useCallback(() => {
    if (!currentSelection || !currentPendingComment.trim()) return;

    const annotation: Annotation = {
      ...currentSelection,
      comment: currentPendingComment.trim(),
    };

    setPendingAnnotations((prev) => [...prev, annotation]);
    setCurrentSelection(null);
    setCurrentPendingComment("");
    setSubmitStatus("idle");
    setSubmitError(null);
  }, [currentSelection, currentPendingComment]);

  /**
   * Edit a pending annotation in the queue.
   */
  const onEditAnnotation = useCallback((id: string, comment: string) => {
    setPendingAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, comment } : a))
    );
  }, []);

  /**
   * Delete a pending annotation from the queue.
   */
  const onDeleteAnnotation = useCallback((id: string) => {
    setPendingAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const onSaveTex = useCallback(
    async (content: string) => {
      if (!texFilePath || isSavingTex || isCompiling || isAgentBusy) return;

      setIsSavingTex(true);
      setIsCompiling(true);
      setLastError(null);
      try {
        await apiFetch<FileSaveResponse>("/api/file/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: texFilePath, content }),
        });

        const compile = await apiFetch<RecompileResponse>("/api/compile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        setTexContent(content);
        setPdfVersion((prev) => (compile.pdfVersion > prev ? compile.pdfVersion : prev));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(msg);
        throw err;
      } finally {
        setIsCompiling(false);
        setIsSavingTex(false);
      }
    },
    [texFilePath, isSavingTex, isCompiling, isAgentBusy]
  );

  /**
   * Submit all pending annotations to the OpenCode session at once.
   * This calls POST /api/review/submit-batch.
   */
  const onSubmitAll = useCallback(async () => {
    const pending = pendingAnnotationsRef.current;
    if (pending.length === 0 || isSavingTex || isCompiling || isAgentBusy) return;

    setIsSubmitting(true);
    setIsAgentBusy(true);
    setSubmitStatus("idle");
    setSubmitError(null);

    try {
      await apiFetch("/api/review/submit-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations: pending }),
      });

      // Add all to local store
      setAnnotations((prev) => {
        const updatedList = [...prev];
        for (const ann of pending) {
          const idx = updatedList.findIndex((a) => a.id === ann.id);
          const updated: Annotation = { ...ann, reviewStatus: "submitted" };
          if (idx >= 0) {
            updatedList[idx] = updated;
          } else {
            updatedList.push(updated);
          }
        }
        return updatedList;
      });

      // Clear pending queue
      setPendingAnnotations([]);
      setCurrentSelection(null);
      setCurrentPendingComment("");
      setSubmitStatus("ok");

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSubmitStatus("error");
      setSubmitError(msg);
      setIsAgentBusy(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [isSavingTex, isCompiling, isAgentBusy]);

  const onSelectAnnotation = useCallback((id: string | null) => {
    setActiveAnnotationId(id);
    const ann = annotationsRef.current.find((a) => a.id === id);
    if (ann) {
      setSyncHighlight({ texFile: ann.texFile, texLine: ann.texLine, texColumn: 0 });
      setReverseSyncHighlight({
        page: ann.page,
        x: ann.bbox[0],
        y: ann.bbox[1],
        width: 60,
        height: 10,
        origin: ann.coordOrigin ?? "pdf",
      });
      if (ann.texFile !== texFilePath) {
        apiFetch<{ path: string; content: string }>(
          `/api/file?path=${encodeURIComponent(ann.texFile)}`
        )
          .then(({ content, path }) => {
            setTexContent(content);
            setTexFilePath(path);
          })
          .catch(() => {});
      }
    }
  }, [texFilePath]);

  const onClearPending = useCallback(() => {
    setCurrentSelection(null);
    setCurrentPendingComment("");
    setSyncHighlight(null);
    setReverseSyncHighlight(null);
    setSubmitStatus("idle");
    setSubmitError(null);
  }, []);

  /**
   * Close without submitting — clear pending and close tab.
   */
  const onCloseWithoutSubmit = useCallback(() => {
    setPendingAnnotations([]);
    setCurrentSelection(null);
    setCurrentPendingComment("");
    window.close();
  }, []);

  // ── Build ReviewState for context ─────────────────────────────────────────
  const reviewStateValue = useMemo<ReviewStateContextValue>(
    () => ({
      // ReviewState fields
      pdfPath: config?.pdfPath ?? "",
      directory: config?.directory ?? "",
      annotations,
      activeAnnotationId,
      syncHighlight,
      reverseSyncHighlight,
      texContent,
      texFilePath,
      isSyncing,
      isSubmitting,
      isSavingTex,
      isCompiling,
      isAgentBusy,
      isUiLocked: isSavingTex || isCompiling || isAgentBusy,
      pdfVersion,
      lastError,
      // Handlers
      onPdfClick,
      onLatexLineClick,
      onLatexCursorLineChange,
      onCommentChange,
      onAddAnnotation,
      onEditAnnotation,
      onDeleteAnnotation,
      onSubmitAll,
      onSaveTex,
      onSelectAnnotation,
      onCloseWithoutSubmit,
      pendingAnnotations,
      currentPendingComment,
      submitStatus,
      submitError,
    }),
    [
      config,
      annotations,
      activeAnnotationId,
      syncHighlight,
      reverseSyncHighlight,
      texContent,
      texFilePath,
      isSyncing,
      isSubmitting,
      isSavingTex,
      isCompiling,
      isAgentBusy,
      pdfVersion,
      lastError,
      onPdfClick,
      onLatexLineClick,
      onLatexCursorLineChange,
      onCommentChange,
      onAddAnnotation,
      onEditAnnotation,
      onDeleteAnnotation,
      onSubmitAll,
      onSaveTex,
      onSelectAnnotation,
      onCloseWithoutSubmit,
      pendingAnnotations,
      currentPendingComment,
      submitStatus,
      submitError,
    ]
  );

  const syncLoadingValue = useMemo<SyncLoadingContextValue>(
    () => ({ isSyncing }),
    [isSyncing]
  );

  // ── Render ────────────────────────────────────────────────────────────────
  if (configError) {
    return (
      <div style={{ padding: 24, color: "#f78166" }}>
        <strong>Failed to load review session:</strong>
        <pre style={{ marginTop: 8, fontSize: 12 }}>{configError}</pre>
      </div>
    );
  }

  if (!config) return null; // Loading spinner shown by HTML until config loads

  return (
    <ReviewStateContext.Provider value={reviewStateValue}>
      <SyncLoadingContext.Provider value={syncLoadingValue}>
        <SplitView />
      </SyncLoadingContext.Provider>
    </ReviewStateContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Entry point called from index.html
// ---------------------------------------------------------------------------

export function initApp(rootEl: HTMLElement | null): void {
  if (!rootEl) return;
  const root = createRoot(rootEl);
  root.render(<App />);
}
