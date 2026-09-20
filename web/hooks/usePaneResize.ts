"use client";

// Listeners live on `window`, so the gesture must close on *every* way a
// pointer can end — `pointerup`, `pointercancel` (the browser reclaiming a
// touch as a scroll), losing capture — or the next press moves the panel.

import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";

/** The slice of a pointer event the gesture reads. */
export interface PaneResizePointerEvent {
  pointerId: number;
  clientX: number;
  cancelable?: boolean;
  preventDefault: () => void;
}
export interface PaneResizeStartEvent extends PaneResizePointerEvent {
  isPrimary: boolean;
  button: number;
}
/** Where the gesture registers its window listeners; injected for tests. */
export interface PaneResizeListenerSource {
  addListener: (
    type: string,
    listener: (event: PaneResizePointerEvent) => void,
    options?: AddEventListenerOptions,
  ) => void;
  removeListener: (
    type: string,
    listener: (event: PaneResizePointerEvent) => void,
  ) => void;
}
export interface PaneResizeGestureDeps extends PaneResizeListenerSource {
  /** Called once per gesture, at pointerdown. */
  getStartWidth: () => number;
  /** Called for every accepted move; `start` is the pointerdown event. */
  computeWidth: (
    startWidth: number,
    event: PaneResizePointerEvent,
    start: PaneResizeStartEvent,
  ) => number;
  onWidth: (width: number) => void;
  /** Exactly once per gesture, with the final width. */
  onEnd?: (width: number) => void;
}
export interface PaneResizeGesture {
  /** Returns false and does nothing when the press cannot start a drag. */
  start: (event: PaneResizeStartEvent) => boolean;
  isActive: () => boolean;
  /** End an in-flight drag early (component unmount). Idempotent. */
  dispose: () => void;
}

const GESTURE_EVENTS = [
  "pointermove", "pointerup", "pointercancel", "lostpointercapture",
] as const;
const LISTENER_OPTIONS: AddEventListenerOptions = { passive: false };
const asListener = (listener: (event: PaneResizePointerEvent) => void) =>
  listener as unknown as EventListener;

// Pure pointer gesture: a press owns one drag until it ends, however it ends.
// No React and no DOM — drive it with plain objects from a test.
export function createPaneResizeGesture(
  deps: PaneResizeGestureDeps,
): PaneResizeGesture {
  let activePointerId: number | null = null;
  let startEvent: PaneResizeStartEvent | null = null;
  let startWidth = 0;
  let lastWidth = 0;

  const listenerFor = (type: string) =>
    type === "pointermove" ? onMove : onEnd;

  const onMove = (event: PaneResizePointerEvent) => {
    // A stray pointer (a second finger, a synthesized event) must not steer
    // the drag the first one owns.
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    const start = startEvent;
    if (!start) return;
    const width = deps.computeWidth(startWidth, event, start);
    lastWidth = width;
    deps.onWidth(width);
    if (event.cancelable !== false) event.preventDefault();
  };

  const onEnd = () => finish();

  function finish() {
    if (activePointerId === null) return;
    activePointerId = null;
    startEvent = null;
    for (const type of GESTURE_EVENTS)
      deps.removeListener(type, listenerFor(type));
    deps.onEnd?.(lastWidth);
  }

  function start(event: PaneResizeStartEvent): boolean {
    if (activePointerId !== null) return false;
    if (!event.isPrimary) return false;
    // 0 is the primary button for touch, pen and the left mouse button alike;
    // anything else (a right-click, a middle-click) is not a resize.
    if (event.button !== 0) return false;
    event.preventDefault();
    activePointerId = event.pointerId;
    startEvent = event;
    startWidth = deps.getStartWidth();
    lastWidth = startWidth;
    for (const type of GESTURE_EVENTS)
      deps.addListener(type, listenerFor(type), LISTENER_OPTIONS);
    return true;
  }

  return { start, isActive: () => activePointerId !== null, dispose: finish };
}

export interface PaneResizeOptions {
  /** pointerdown 时调用一次，取手势起始宽度(px) */
  getStartWidth: () => number;
  /** 每次被接受的 pointermove 调用；start 是 pointerdown 事件，用于算 delta */
  computeWidth: (
    startWidth: number,
    event: PointerEvent,
    start: PointerEvent,
  ) => number;
  /** 应用宽度：每次 move 调用，手势结束时再以最终值调用一次 */
  onWidth: (width: number) => void;
  /** 手势结束恰好一次：pointerup / pointercancel / lostpointercapture / 组件卸载 */
  onEnd?: (width: number) => void;
}
export interface PaneResize {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  isResizing: boolean;
}

/** React binding around `createPaneResizeGesture`. */
export function usePaneResize(options: PaneResizeOptions): PaneResize {
  // Read through a ref so callers never have to memoize their handlers.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const [isResizing, setIsResizing] = useState(false);
  const gestureRef = useRef<PaneResizeGesture | null>(null);

  const getGesture = useCallback((): PaneResizeGesture | null => {
    if (typeof window === "undefined") return null;
    if (!gestureRef.current) {
      gestureRef.current = createPaneResizeGesture({
        getStartWidth: () => optionsRef.current.getStartWidth(),
        computeWidth: (startWidth, event, start) =>
          optionsRef.current.computeWidth(
            startWidth,
            event as PointerEvent,
            start as unknown as PointerEvent,
          ),
        onWidth: (width) => optionsRef.current.onWidth(width),
        onEnd: (width) => {
          setIsResizing(false);
          optionsRef.current.onEnd?.(width);
        },
        addListener: (type, listener, opts) =>
          window.addEventListener(type, asListener(listener), opts),
        removeListener: (type, listener) =>
          window.removeEventListener(type, asListener(listener)),
      });
    }
    return gestureRef.current;
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const gesture = getGesture();
      if (!gesture) return;
      const started = gesture.start({
        pointerId: event.pointerId,
        clientX: event.clientX,
        cancelable: event.cancelable,
        isPrimary: event.isPrimary,
        button: event.button,
        preventDefault: () => event.preventDefault(),
      });
      if (!started) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Capture is a nicety; a browser may refuse it for a stale pointer.
      }
      setIsResizing(true);
    },
    [getGesture],
  );

  // Unmounting mid-drag still owes the caller its onEnd(width).
  useEffect(() => () => gestureRef.current?.dispose(), []);

  return { onPointerDown, isResizing };
}
