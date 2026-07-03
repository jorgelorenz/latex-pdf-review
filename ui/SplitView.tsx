/**
 * ui/SplitView.tsx
 *
 * Top-level layout component: header bar + resizable PDF/LaTeX split.
 *
 * Architecture:
 *   - Reads ALL state from ReviewStateContext (plannotator thin-adapter pattern)
 *   - Owns only the resize drag state (local — not shared)
 *   - Renders: HeaderBar | PdfPane | ResizeHandle | LatexPane + CommentPanel
 */

import React, { useCallback, useRef, useState } from "react";
import { useReviewState, useSyncLoading } from "./App.tsx";
import { PdfPane } from "./PdfPane.tsx";
import { LatexPane } from "./LatexPane.tsx";

// ---------------------------------------------------------------------------
// Header bar
// ---------------------------------------------------------------------------

function HeaderBar() {
  const {
    pdfPath,
    annotations,
    pendingAnnotations,
    lastError,
    onCloseWithoutSubmit,
    isSavingTex,
    isCompiling,
    isAgentBusy,
  } = useReviewState();
  const { isSyncing } = useSyncLoading();

  const pdfName = pdfPath.split(/[\\/]/).pop() ?? pdfPath;
  const submittedCount = annotations.filter(
    (a) => a.reviewStatus === "submitted"
  ).length;

  return (
    <div className="header-bar">
      <span className="title">LaTeX PDF Review</span>
      <span className="pdf-path" title={pdfPath}>
        {pdfName}
      </span>

      {lastError && (
        <span
          style={{ fontSize: 11, color: "#f78166", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={lastError}
        >
          {lastError}
        </span>
      )}

        <span className={`status-badge${isSyncing ? " syncing" : ""}`}>
        {isSavingTex
          ? "Saving..."
          : isCompiling
          ? "Compiling..."
          : isAgentBusy
          ? "Agent busy"
          : isSyncing
          ? "Syncing…"
          : submittedCount > 0
          ? `${submittedCount} submitted`
          : pendingAnnotations.length > 0
          ? `${pendingAnnotations.length} pending`
          : "Ready"}
      </span>

      <button
        onClick={onCloseWithoutSubmit}
        style={{
          marginLeft: "auto",
          padding: "4px 8px",
          fontSize: 11,
          background: "#30363d",
          border: "1px solid #21262d",
          color: "#8b949e",
          borderRadius: 4,
          cursor: "pointer",
        }}
        title="Close without submitting"
      >
        Close
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comment panel (bottom of LaTeX pane)
// ---------------------------------------------------------------------------

function CommentPanel() {
  const {
    syncHighlight,
    currentPendingComment,
    onCommentChange,
    onAddAnnotation,
    pendingAnnotations,
    onEditAnnotation,
    onDeleteAnnotation,
    onSubmitAll,
    isSubmitting,
    isUiLocked,
    submitStatus,
    submitError,
    annotations,
    activeAnnotationId,
    onSelectAnnotation,
    pdfPath,
  } = useReviewState();

  const canAddAnnotation =
    syncHighlight !== null && currentPendingComment.trim().length > 0 && !isSubmitting && !isUiLocked;
  const canSubmitAll = pendingAnnotations.length > 0 && !isSubmitting && !isUiLocked;

  const syncInfoText = syncHighlight
    ? `${syncHighlight.texFile.split(/[\\/]/).pop()}:${syncHighlight.texLine}`
    : "Click in PDF to select a location";

  return (
    <div className="comment-panel">
      <div className="comment-panel-header">Review Comment</div>

      <div className={`sync-info${syncHighlight ? "" : " empty"}`}>
        {syncInfoText}
      </div>

      <textarea
        className="comment-textarea"
        placeholder={
          syncHighlight
            ? "Describe the change needed…"
            : "Click somewhere in the PDF first, then write your comment here."
        }
        value={currentPendingComment}
        onChange={(e) => onCommentChange(e.target.value)}
        disabled={!syncHighlight || isSubmitting || isUiLocked}
        rows={3}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (canAddAnnotation) onAddAnnotation();
          }
        }}
      />

      <div className="comment-actions">
        <button
          className="btn-submit"
          onClick={onAddAnnotation}
          disabled={!canAddAnnotation}
          title="Add to queue (Ctrl+Enter)"
        >
          {isSubmitting ? "Submitting…" : "Add Comment"}
        </button>
        <button
          className="btn-clear"
          onClick={() => {
            onCommentChange("");
          }}
          disabled={isSubmitting || currentPendingComment.length === 0 || isUiLocked}
        >
          Clear
        </button>
        {submitStatus === "ok" && (
          <span className="submit-status ok">Submitted!</span>
        )}
        {submitStatus === "error" && (
          <span className="submit-status err" title={submitError ?? ""}>
            Error
          </span>
        )}
      </div>

      {/* Pending annotations queue */}
      {pendingAnnotations.length > 0 && (
        <>
          <div className="comment-panel-header" style={{ marginTop: 8 }}>
            Pending ({pendingAnnotations.length})
          </div>
          <div className="annotation-list">
            {pendingAnnotations.map((ann) => (
              <div
                key={ann.id}
                style={{
                  padding: "6px 8px",
                  borderRadius: 4,
                  border: "1px solid #30363d",
                  fontSize: 11,
                  background: "#0d1117",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginBottom: 4,
                }}
              >
                <span style={{ color: "#79c0ff", fontFamily: "monospace" }}>
                  p{ann.page}:{ann.texLine}
                </span>
                <span
                  style={{
                    color: "#8b949e",
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={ann.comment}
                >
                  {ann.comment}
                </span>
                <button
                  onClick={() => {
                    const newComment = prompt("Edit comment:", ann.comment);
                    if (newComment !== null) {
                      onEditAnnotation(ann.id, newComment);
                    }
                  }}
                  disabled={isUiLocked}
                  style={{
                    padding: "2px 6px",
                    fontSize: 10,
                    background: "#21262d",
                    border: "1px solid #30363d",
                    color: "#8b949e",
                    borderRadius: 2,
                    cursor: "pointer",
                  }}
                >
                  Edit
                </button>
                <button
                  onClick={() => onDeleteAnnotation(ann.id)}
                  disabled={isUiLocked}
                  style={{
                    padding: "2px 6px",
                    fontSize: 10,
                    background: "#21262d",
                    border: "1px solid #30363d",
                    color: "#f78166",
                    borderRadius: 2,
                    cursor: "pointer",
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <button
            className="btn-submit"
            onClick={onSubmitAll}
            disabled={!canSubmitAll}
            style={{ width: "100%", marginTop: 8 }}
            title={`Submit all ${pendingAnnotations.length} comments to agent`}
          >
            {isSubmitting ? "Submitting…" : `Send Feedback (${pendingAnnotations.length})`}
          </button>
        </>
      )}

      {/* Annotation history */}
      {annotations.length > 0 && (
        <>
          <div className="comment-panel-header" style={{ marginTop: 8 }}>
            Previous ({annotations.length})
          </div>
          <div className="annotation-list">
            {annotations.map((ann) => (
              <div
                key={ann.id}
                className={`annotation-item${activeAnnotationId === ann.id ? " active" : ""}`}
                onClick={() =>
                  onSelectAnnotation(
                    activeAnnotationId === ann.id ? null : ann.id
                  )
                }
                title={ann.comment}
              >
                <span
                  className={`ann-status ${ann.reviewStatus}`}
                />
                <span className="ann-loc">
                  p{ann.page}:{ann.texLine}
                </span>
                <span className="ann-comment">{ann.comment}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Split view with resize handle
// ---------------------------------------------------------------------------

const MIN_PANEL_WIDTH = 280;

export function SplitView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftFraction, setLeftFraction] = useState(0.5);
  const isDragging = useRef(false);

  const onMouseDownHandle = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const container = containerRef.current;
    if (!container) return;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const rect = container.getBoundingClientRect();
      const totalWidth = rect.width;
      const offset = ev.clientX - rect.left;
      const fraction = Math.min(
        Math.max(offset / totalWidth, MIN_PANEL_WIDTH / totalWidth),
        1 - MIN_PANEL_WIDTH / totalWidth
      );
      setLeftFraction(fraction);
    };

    const onMouseUp = () => {
      isDragging.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  return (
    <div className="split-container">
      <HeaderBar />
      <div className="panes-row" ref={containerRef}>
        {/* Left: PDF pane */}
        <div
          className="pdf-pane"
          style={{ flex: `0 0 ${(leftFraction * 100).toFixed(2)}%` }}
        >
          <PdfPane />
        </div>

        {/* Resize handle */}
        <div className="resize-handle" onMouseDown={onMouseDownHandle} />

        {/* Right: LaTeX pane + comment panel */}
        <div className="latex-pane" style={{ flex: "1 1 0" }}>
          <LatexPane />
          <CommentPanel />
        </div>
      </div>
    </div>
  );
}
