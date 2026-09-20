"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import { usePaneResize } from "@/hooks/usePaneResize";

import { clampPanelRatio } from "../model/editor-state";
import { loadSplitRatio, saveSplitRatio } from "../storage/drafts";

export function useSplitPane(containerRef: RefObject<HTMLElement | null>) {
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [editorRatio, setEditorRatio] = useState(0.5);
  const preferencesLoadedRef = useRef(false);
  const showEditor = !editorCollapsed;
  const showPreview = !previewCollapsed;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setEditorRatio(loadSplitRatio(window.localStorage));
      preferencesLoadedRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!preferencesLoadedRef.current) return;
    saveSplitRatio(window.localStorage, editorRatio);
  }, [editorRatio]);

  const { isResizing: isResizingSplit, onPointerDown: handleSplitterPointerDown } =
    usePaneResize({
      getStartWidth: () => editorRatio,
      computeWidth: (startWidth, event) => {
        const container = containerRef.current;
        if (!container) return startWidth;
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0) return startWidth;
        return clampPanelRatio((event.clientX - rect.left) / rect.width);
      },
      // Persistence keeps riding the existing effect below: every ratio change
      // (including the final one committed on up/cancel) is saved.
      onWidth: setEditorRatio,
      // Idempotent final commit so a pointercancel still persists the ratio.
      onEnd: setEditorRatio,
    });

  return {
    editorCollapsed,
    editorRatio,
    handleSplitterPointerDown,
    isResizingSplit,
    previewCollapsed,
    setEditorCollapsed,
    setEditorRatio,
    setPreviewCollapsed,
    showEditor,
    showPreview,
  };
}
