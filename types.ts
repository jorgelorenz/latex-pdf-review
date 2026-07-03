/**
 * Core types for the latex-pdf-review plugin.
 * Models the PDF ↔ LaTeX synchronization state and annotation lifecycle.
 */

// ---------------------------------------------------------------------------
// SyncTeX mapping types
// ---------------------------------------------------------------------------

/** Result from `synctex edit` — PDF coordinates → LaTeX source location */
export interface SyncResult {
  /** Absolute path to the resolved .tex file */
  texFile: string;
  /** 1-indexed line number in the .tex file */
  texLine: number;
  /** 1-indexed column (may be 0 if unavailable) */
  texColumn: number;
  /** Optional: end column for highlighting a range (1-indexed) */
  texColumnEnd?: number;
}

/** Result from `synctex view` — LaTeX source location → PDF coordinates */
export interface ReverseSyncResult {
  /** 1-indexed PDF page number */
  page: number;
  /** Horizontal position in PDF points (from left edge) */
  x: number;
  /** Vertical position in PDF points (from top edge) */
  y: number;
  /** Width of the highlighted region in PDF points */
  width: number;
  /** Height of the highlighted region in PDF points */
  height: number;
  /** Coordinate origin used by y (pdf=bottom-left, synctex=top-left) */
  origin?: "pdf" | "synctex";
}

// ---------------------------------------------------------------------------
// Annotation model (one annotation = one PDF selection + comment + resolved LaTeX loc)
// ---------------------------------------------------------------------------

export interface Annotation {
  /** Unique identifier (short random string) */
  id: string;
  /** Absolute or relative path to the PDF file being reviewed */
  pdfFile: string;
  /** 1-indexed PDF page number of the selection */
  page: number;
  /** [x, y] in PDF coordinate space (points, origin at bottom-left) */
  bbox: [number, number];
  /** Coordinate origin for bbox y value */
  coordOrigin?: "pdf" | "synctex";
  /** Optional text selected/highlighted in the PDF */
  selectedText?: string;
  /** Human-written review comment */
  comment: string;
  /** Resolved .tex file path (from SyncTeX) */
  texFile: string;
  /** Resolved line number in the .tex file (from SyncTeX) */
  texLine: number;
  /** Unix timestamp of creation */
  createdAt: number;
  /** Status of the OpenCode agent review for this annotation */
  reviewStatus: "pending" | "submitted" | "applied";
}

// ---------------------------------------------------------------------------
// Review session state (mirrors plannotator ReviewState context pattern)
// ---------------------------------------------------------------------------

export interface ReviewState {
  /** Path to the PDF being reviewed */
  pdfPath: string;
  /** Directory where the PDF and .tex files live */
  directory: string;
  /** All annotations created in this session */
  annotations: Annotation[];
  /** ID of the annotation currently selected/highlighted */
  activeAnnotationId: string | null;
  /** Current SyncTeX forward-sync result (PDF → LaTeX) */
  syncHighlight: SyncResult | null;
  /** Current SyncTeX reverse-sync result (LaTeX → PDF) */
  reverseSyncHighlight: ReverseSyncResult | null;
  /** Content of the currently displayed .tex file */
  texContent: string;
  /** Path of the currently displayed .tex file */
  texFilePath: string;
  /** Whether a SyncTeX call is in-flight */
  isSyncing: boolean;
  /** Whether a review submission is in-flight */
  isSubmitting: boolean;
  /** Whether saving the active .tex file is in-flight */
  isSavingTex: boolean;
  /** Whether PDF recompilation is in-flight */
  isCompiling: boolean;
  /** Whether the agent is currently generating a response */
  isAgentBusy: boolean;
  /** Global lock while operations should prevent editing */
  isUiLocked: boolean;
  /** Monotonic version used to refresh PDF bytes in the viewer */
  pdfVersion: number;
  /** Non-fatal error message to surface in the UI */
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// API request / response shapes (used by server.ts and the UI fetch calls)
// ---------------------------------------------------------------------------

export interface SynctexEditRequest {
  pdfFile: string;
  page: number;
  x: number;
  y: number;
}

export interface SynctexViewRequest {
  texFile: string;
  line: number;
  pdfFile: string;
}

export interface AnnotationSubmitRequest {
  annotation: Annotation;
}

export interface BatchAnnotationSubmitRequest {
  annotations: Annotation[];
}

export interface AnnotationSubmitResponse {
  ok: boolean;
  /** The prompt that was injected into the OpenCode session */
  prompt: string;
}

export interface BatchAnnotationSubmitResponse {
  ok: boolean;
  /** Combined prompt for all annotations */
  prompt: string;
  /** Count of annotations submitted */
  count: number;
}

export interface ConfigResponse {
  pdfPath: string;
  directory: string;
  sessionId: string;
}

export interface FileReadResponse {
  path: string;
  content: string;
}

export interface FileSaveRequest {
  path: string;
  content: string;
}

export interface FileSaveResponse {
  ok: boolean;
  path: string;
}

export interface RecompileResponse {
  ok: boolean;
  pdfVersion: number;
}

export interface UiStatusResponse {
  pdfVersion: number;
  isCompiling: boolean;
  isAgentBusy: boolean;
}

export interface ErrorResponse {
  error: string;
  detail?: string;
}
