import assert from "node:assert/strict";
import test from "node:test";

import {
  createPaneResizeGesture,
  type PaneResizePointerEvent,
  type PaneResizeStartEvent,
} from "../hooks/usePaneResize";

/** A window-like listener registry, so no real DOM is needed. */
class FakeTarget {
  private listeners = new Map<string, Set<Listener>>();
  readonly addCalls: string[] = [];
  readonly removeCalls: string[] = [];

  addEventListener(type: string, listener: Listener): void {
    this.addCalls.push(type);
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.removeCalls.push(type);
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: PaneResizePointerEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

type Listener = (event: PaneResizePointerEvent) => void;

const GESTURE_EVENTS = [
  "pointermove",
  "pointerup",
  "pointercancel",
  "lostpointercapture",
];

function down(overrides: Partial<PaneResizeStartEvent> = {}): PaneResizeStartEvent {
  return {
    pointerId: 1,
    clientX: 500,
    cancelable: true,
    isPrimary: true,
    button: 0,
    preventDefault() {},
    ...overrides,
  };
}

function move(pointerId: number, clientX: number): PaneResizePointerEvent {
  return { pointerId, clientX, cancelable: true, preventDefault() {} };
}

function makeGesture() {
  const target = new FakeTarget();
  const widths: number[] = [];
  const ends: number[] = [];
  const gesture = createPaneResizeGesture({
    getStartWidth: () => 300,
    // Companion-style: dragging left widens by the negative delta.
    computeWidth: (startWidth, event, start) =>
      startWidth + (start.clientX - event.clientX),
    onWidth: (width) => widths.push(width),
    onEnd: (width) => ends.push(width),
    addListener: (type, listener) => target.addEventListener(type, listener),
    removeListener: (type, listener) => target.removeEventListener(type, listener),
  });
  return { gesture, target, widths, ends };
}

test("a pointermove with no pointerdown never changes the width", () => {
  const { gesture, target, widths, ends } = makeGesture();

  target.dispatch("pointermove", move(1, 200));

  assert.equal(gesture.isActive(), false);
  assert.deepEqual(widths, []);
  assert.deepEqual(ends, []);
  assert.equal(target.addCalls.length, 0);
});

test("a move from a second pointer id is ignored", () => {
  const { gesture, target, widths } = makeGesture();
  assert.equal(gesture.start(down()), true);

  target.dispatch("pointermove", move(2, 100));
  assert.deepEqual(widths, []);

  target.dispatch("pointermove", move(1, 480));
  assert.deepEqual(widths, [320]);
});

test("pointercancel lands the width and removes every listener", () => {
  const { gesture, target, widths, ends } = makeGesture();
  gesture.start(down());

  target.dispatch("pointermove", move(1, 490));
  assert.deepEqual(widths, [310]);

  target.dispatch("pointercancel", move(1, 490));

  assert.deepEqual(ends, [310]);
  assert.equal(gesture.isActive(), false);
  for (const type of GESTURE_EVENTS) {
    assert.ok(target.addCalls.includes(type), `added ${type}`);
    assert.ok(target.removeCalls.includes(type), `removed ${type}`);
    assert.equal(target.count(type), 0, `detached ${type}`);
  }
});

test("unmounting mid-drag still reports the final width once", () => {
  const { gesture, target, ends } = makeGesture();
  gesture.start(down());
  target.dispatch("pointermove", move(1, 495));
  assert.equal(gesture.isActive(), true);

  gesture.dispose();
  assert.deepEqual(ends, [305]);

  gesture.dispose();
  assert.deepEqual(ends, [305]);
  assert.equal(gesture.isActive(), false);
});

test("a non-primary pointer or a non-left button never starts a gesture", () => {
  const { gesture, target, widths, ends } = makeGesture();

  assert.equal(gesture.start(down({ button: 2 })), false);
  assert.equal(gesture.start(down({ isPrimary: false })), false);

  assert.equal(gesture.isActive(), false);
  assert.equal(target.addCalls.length, 0);

  target.dispatch("pointermove", move(1, 100));
  assert.deepEqual(widths, []);
  assert.deepEqual(ends, []);
});

test("pointerup ends the gesture and reports the width once", () => {
  const { gesture, target, widths, ends } = makeGesture();
  gesture.start(down());

  target.dispatch("pointermove", move(1, 520));
  assert.deepEqual(widths, [280]);

  target.dispatch("pointerup", move(1, 520));
  assert.deepEqual(ends, [280]);
  assert.equal(gesture.isActive(), false);

  // A late duplicate end event must not fire onEnd again.
  target.dispatch("lostpointercapture", move(1, 520));
  assert.deepEqual(ends, [280]);
});
