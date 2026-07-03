/**
 * ui/PdfPane.tsx
 *
 * Left panel: PDF viewer powered by PDF.js.
 *
 * Responsibilities:
 *   - Load and render the PDF from the server
 *   - Convert canvas click → PDF coordinate space → call onPdfClick()
 *   - Accept selected text via mouseup text selection
 *   - Display reverse-sync highlight overlay (LaTeX → PDF direction)
 *   - Render annotation pins for previously saved annotations
 *   - Provide page navigation controls
 *
 * PDF.js is loaded from CDN via a dynamic import() inside useEffect so
 * no bundler is required. The worker URL is set to the CDN build.
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useReviewState, useSyncLoading } from "./App.tsx";
import type { Annotation, ReverseSyncResult } from "../types.ts";

// ---------------------------------------------------------------------------
// PDF.js type stubs (minimal — avoids needing @types/pdfjs-dist)
// ---------------------------------------------------------------------------
interface PdfjsLib {
  getDocument: (src: { url: string; workerSrc: string }) => { promise: Promise<PdfDocument> };
  GlobalWorkerOptions: { workerSrc: string };
}

interface PdfDocument {
  numPages: number;
  getPage: (pageNum: number) => Promise<PdfPage>;
}

interface PdfPage {
  getViewport: (opts: { scale: number }) => PdfViewport;
  render: (ctx: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => { promise: Promise<void> };
}

interface PdfViewport {
  width: number;
  height: number;
  /** Convert [x, y] from PDF user space to canvas pixels */
  convertToViewportPoint?: (x: number, y: number) => [number, number];
  /** Convert [x, y] from canvas pixels to PDF user space */
  convertToPdfPoint?: (x: number, y: number) => [number, number];
  transform: number[];
}

// CDN URL for PDF.js
const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
const PDFJS_WORKER_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

const RENDER_SCALE = 1.6; // Higher = sharper but slower

// ---------------------------------------------------------------------------
// Coordinate conversion utilities
// ---------------------------------------------------------------------------

/**
 * Convert canvas pixel coordinates to PDF user-space coordinates.
 * PDF user space: origin at bottom-left, y increases upward.
 * Canvas space: origin at top-left, y increases downward.
 */
function canvasToPdfCoords(
  canvasX: number,
  canvasY: number,
  viewport: PdfViewport
): [number, number] {
  if (viewport.convertToPdfPoint) {
    return viewport.convertToPdfPoint(canvasX, canvasY) as [number, number];
  }
  // Manual conversion using the viewport transform matrix
  // transform = [scaleX, 0, 0, -scaleY, offsetX, offsetY]
  const [scaleX, , , scaleY, offsetX, offsetY] = viewport.transform;
  const pdfX = (canvasX - offsetX) / scaleX;
  const pdfY = (canvasY - offsetY) / scaleY;
  return [pdfX, pdfY];
}

/**
 * Convert PDF.js user-space Y (bottom-origin) to SyncTeX Y (top-origin).
 *
 * SyncTeX `edit -o page:x:y:file` expects Y measured from the top of page,
 * while PDF.js coordinates are measured from the bottom.
 */
function pdfToSynctexCoords(
  pdfX: number,
  pdfY: number,
  viewport: PdfViewport
): [number, number] {
  const [, pdfYAtTop] = canvasToPdfCoords(0, 0, viewport);
  const synctexY = Math.abs(pdfYAtTop - pdfY);
  return [pdfX, synctexY];
}

/**
 * Convert PDF user-space coordinates to canvas pixel coordinates.
 * Used to position the reverse-sync highlight overlay.
 */
function pdfToCanvasCoords(
  pdfX: number,
  pdfY: number,
  viewport: PdfViewport
): [number, number] {
  if (viewport.convertToViewportPoint) {
    return viewport.convertToViewportPoint(pdfX, pdfY) as [number, number];
  }
  const [scaleX, , , scaleY, offsetX, offsetY] = viewport.transform;
  const canvasX = pdfX * scaleX + offsetX;
  const canvasY = pdfY * scaleY + offsetY;
  return [canvasX, canvasY];
}

// ---------------------------------------------------------------------------
// PdfPane component
// ---------------------------------------------------------------------------

export function PdfPane() {
  const {
    pdfPath,
    onPdfClick,
    reverseSyncHighlight,
    annotations,
    activeAnnotationId,
    onSelectAnnotation,
    pdfVersion,
    isUiLocked,
  } = useReviewState();
  const { isSyncing } = useSyncLoading();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<PdfViewport | null>(null);

  const [pdfDoc, setPdfDoc] = useState<PdfDocument | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [isRendering, setIsRendering] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const lastPdfPathRef = useRef<string | null>(null);

  // Stable refs to avoid stale closures in event handlers
  const viewportRefStable = viewportRef;
  const currentPageRef = useRef(1);
  currentPageRef.current = currentPage;

  // ── Load PDF.js and the document ─────────────────────────────────────────
  useEffect(() => {
    if (!pdfPath) return;
    let cancelled = false;

    (async () => {
      try {
        // Dynamic import from CDN — runs once
        const pdfjsLib = (await import(PDFJS_CDN)) as PdfjsLib;
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;

        // The server exposes the PDF via /api/file?path=... (read as binary)
        // For simplicity we serve the raw PDF directly.
        // The server.ts will be updated to serve raw PDF bytes at /pdf.
        const pdfUrl = `/pdf?path=${encodeURIComponent(pdfPath)}&v=${pdfVersion}`;

        const loadTask = pdfjsLib.getDocument({ url: pdfUrl, workerSrc: PDFJS_WORKER_CDN });
        const doc = await loadTask.promise;
        if (cancelled) return;
        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        const pathChanged = lastPdfPathRef.current !== pdfPath;
        lastPdfPathRef.current = pdfPath;
        if (pathChanged) {
          setCurrentPage(1);
        } else {
          setCurrentPage((prev) => Math.min(Math.max(prev, 1), doc.numPages));
        }
      } catch (err: unknown) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load PDF"
        );
      }
    })();

    return () => { cancelled = true; };
  }, [pdfPath, pdfVersion]);

  // ── Render current page ──────────────────────────────────────────────────
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let cancelled = false;

    (async () => {
      setIsRendering(true);
      try {
        const page = await pdfDoc.getPage(currentPage);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: RENDER_SCALE });
        viewportRefStable.current = viewport;

        const canvas = canvasRef.current!;
        const context = canvas.getContext("2d")!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({ canvasContext: context, viewport }).promise;
      } catch {
        // Render error — ignore, canvas stays blank
      } finally {
        if (!cancelled) setIsRendering(false);
      }
    })();

    return () => { cancelled = true; };
  }, [pdfDoc, currentPage]);

  // ── Handle canvas click → SyncTeX ────────────────────────────────────────
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const viewport = viewportRefStable.current;
      if (!canvas || !viewport) return;

      const rect = canvas.getBoundingClientRect();
      // Account for CSS scaling if canvas is displayed at a different size
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;

      const [pdfX, pdfY] = canvasToPdfCoords(canvasX, canvasY, viewport);
      const [, synctexY] = pdfToSynctexCoords(pdfX, pdfY, viewport);

      // Capture selected text if any
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim() || undefined;

      if (!isUiLocked) {
        onPdfClick(currentPageRef.current, pdfX, pdfY, selectedText, synctexY);
      }
    },
    [isUiLocked, onPdfClick]
  );

  // ── Compute reverse-sync highlight overlay position ──────────────────────
  const highlightStyle = computeHighlightStyle(
    reverseSyncHighlight,
    currentPage,
    viewportRefStable.current
  );

  // ── Annotation pins for this page ────────────────────────────────────────
  const pageAnnotations = annotations.filter(
    (a) => a.page === currentPage
  );

  // ── Page navigation ──────────────────────────────────────────────────────
  const goToPrev = useCallback(() => setCurrentPage((p) => Math.max(1, p - 1)), []);
  const goToNext = useCallback(
    () => setCurrentPage((p) => Math.min(totalPages, p + 1)),
    [totalPages]
  );

  // Jump to the page of reverseSyncHighlight when it changes
  useEffect(() => {
    if (reverseSyncHighlight && reverseSyncHighlight.page !== currentPage) {
      setCurrentPage(reverseSyncHighlight.page);
    }
  }, [reverseSyncHighlight]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="pane-header">
        PDF
        <div className="page-controls">
          <button onClick={goToPrev} disabled={currentPage <= 1 || isRendering}>
            ‹
          </button>
          <span className="page-display">
            {totalPages > 0 ? `${currentPage} / ${totalPages}` : "—"}
          </span>
          <button
            onClick={goToNext}
            disabled={currentPage >= totalPages || isRendering}
          >
            ›
          </button>
        </div>
      </div>

      <div className="pdf-scroll">
        {loadError ? (
          <div className="empty-pdf">
            <div className="error-banner">{loadError}</div>
          </div>
        ) : (
          <div className="pdf-canvas-wrapper">
            <canvas
              ref={canvasRef}
              id="pdf-canvas"
              onClick={handleCanvasClick}
              title="Click to sync with LaTeX source"
              style={{ maxWidth: "100%", display: "block" }}
            />

            {/* Reverse-sync highlight overlay */}
            {highlightStyle && (
              <div
                className="pdf-highlight-overlay"
                style={highlightStyle}
              />
            )}

            {/* Annotation pins */}
            {pageAnnotations.map((ann) => (
              <AnnotationPin
                key={ann.id}
                annotation={ann}
                isActive={activeAnnotationId === ann.id}
                viewport={viewportRefStable.current}
                onClick={() =>
                  onSelectAnnotation(
                    activeAnnotationId === ann.id ? null : ann.id
                  )
                }
              />
            ))}

            {/* Sync loading overlay on canvas */}
            {(isSyncing || isRendering) && (
              <div className="loading-overlay" style={{ position: "absolute", borderRadius: 0 }}>
                <span className="spinner" />
                {isRendering ? "Rendering…" : "Syncing…"}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Annotation pin overlay
// ---------------------------------------------------------------------------

interface AnnotationPinProps {
  annotation: Annotation;
  isActive: boolean;
  viewport: PdfViewport | null;
  onClick: () => void;
}

function AnnotationPin({ annotation, isActive, viewport, onClick }: AnnotationPinProps) {
  if (!viewport) return null;

  const [canvasX, canvasY] = pdfToCanvasCoords(
    annotation.bbox[0],
    annotation.bbox[1],
    viewport
  );

  return (
    <div
      className={`pdf-annotation-pin${isActive ? " active" : ""}`}
      style={{ left: canvasX, top: canvasY }}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={annotation.comment}
    />
  );
}

// ---------------------------------------------------------------------------
// Compute reverse-sync highlight overlay CSS style
// ---------------------------------------------------------------------------

function computeHighlightStyle(
  highlight: ReverseSyncResult | null,
  currentPage: number,
  viewport: PdfViewport | null
): React.CSSProperties | null {
  if (!highlight || !viewport) return null;
  if (highlight.page !== currentPage) return null;

  const [canvasX, canvasY] = pdfToCanvasCoords(highlight.x, highlight.y, viewport);
  const w = (highlight.width || 80) * RENDER_SCALE;
  const h = (highlight.height || 12) * RENDER_SCALE;

  return {
    position: "absolute",
    left: canvasX,
    top: canvasY - h, // PDF y is baseline; show highlight above the point
    width: w,
    height: h + 4,
  };
}
