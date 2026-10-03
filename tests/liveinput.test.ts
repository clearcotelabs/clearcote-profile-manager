// src/lib/liveinput.ts: what the cloud viewer sends to a cloud browser. The worker accepts only a few
// small JSON events (cc-gateway src/live-input.mjs) and drops anything else, so the shapes here are
// the contract: coordinates 0..1 on the picture, the CDP modifier mask, keys of at most 32 characters.

import { describe, it, expect } from "vitest";
import { framePoint, keyEvent, modifiers, mouseButton, navTo, parseLiveText, reconnectDelay, wheelPixels } from "../src/lib/liveinput";

const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
const key = (k: string, over: Partial<typeof none & { code: string; keyCode: number }> = {}) => ({ ...none, key: k, code: `Key${k.toUpperCase()}`, keyCode: k.toUpperCase().charCodeAt(0), ...over });

describe("pointer", () => {
  it("maps a point on the drawn picture to 0..1, inside the letterbox", () => {
    // A 1280x720 frame in a 1000x1000 box: drawn 1000x562.5, centred, bars of 218.75 above and below.
    const box = { left: 100, top: 50, width: 1000, height: 1000 };
    const nat = { width: 1280, height: 720 };
    expect(framePoint(100, 268.75, box, nat)).toEqual({ x: 0, y: 0 });
    expect(framePoint(1100, 831.25, box, nat)).toEqual({ x: 1, y: 1 });
    expect(framePoint(600, 550, box, nat)).toEqual({ x: 0.5, y: 0.5 });
    expect(framePoint(600, 100, box, nat)).toBeNull(); // the bar above
    expect(framePoint(600, 900, box, nat)).toBeNull(); // the bar below
    expect(framePoint(50, 550, box, nat)).toBeNull(); // left of the box
  });

  it("has no point before the first frame arrived", () => {
    expect(framePoint(1, 1, { left: 0, top: 0, width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull();
    expect(framePoint(1, 1, { left: 0, top: 0, width: 0, height: 0 }, { width: 10, height: 10 })).toBeNull();
  });

  it("names buttons the way the worker does, and the CDP modifier mask", () => {
    expect([0, 1, 2, 3, 4].map(mouseButton)).toEqual(["left", "middle", "right", "left", "left"]);
    expect(modifiers(none)).toBe(0);
    expect(modifiers({ ...none, altKey: true })).toBe(1);
    expect(modifiers({ ...none, ctrlKey: true })).toBe(2);
    expect(modifiers({ ...none, metaKey: true })).toBe(4);
    expect(modifiers({ ...none, shiftKey: true })).toBe(8);
    expect(modifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });

  it("turns a wheel in lines or pages into pixels", () => {
    expect(wheelPixels(120, 0)).toBe(120);
    expect(wheelPixels(3, 1)).toBe(120);
    expect(wheelPixels(-1, 2)).toBe(-800);
  });
});

describe("keyboard", () => {
  it("sends a character key with its text, and a named key without", () => {
    expect(keyEvent("down", key("a"))).toEqual({ t: "key", e: "down", key: "a", code: "KeyA", kc: 65, text: "a", m: 0 });
    expect(keyEvent("down", key("A", { shiftKey: true }))).toEqual({ t: "key", e: "down", key: "A", code: "KeyA", kc: 65, text: "A", m: 8 });
    expect(keyEvent("up", { ...none, key: "Enter", code: "Enter", keyCode: 13 })).toEqual({ t: "key", e: "up", key: "Enter", code: "Enter", kc: 13, m: 0 });
    expect(keyEvent("down", { ...none, key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 })).not.toHaveProperty("text");
  });

  it("sends a shortcut without text: Ctrl+A selects, it does not type “a”", () => {
    expect(keyEvent("down", key("a", { ctrlKey: true }))).toEqual({ t: "key", e: "down", key: "a", code: "KeyA", kc: 65, m: 2 });
    expect(keyEvent("down", key("c", { metaKey: true }))).toEqual({ t: "key", e: "down", key: "c", code: "KeyC", kc: 67, m: 4 });
  });

  it("keeps paste (the paste event carries the text) and this window's own shortcuts", () => {
    for (const k of ["v", "V"]) expect(keyEvent("down", key(k, { ctrlKey: true }))).toBeNull();
    expect(keyEvent("down", key("v", { metaKey: true }))).toBeNull();
    for (const k of ["r", "R", "w", "W", "t", "T"]) expect(keyEvent("down", key(k, { ctrlKey: true })), k).toBeNull();
    for (const k of ["F5", "F12"]) expect(keyEvent("down", { ...none, key: k, code: k, keyCode: 116 })).toBeNull();
    // A plain v and plain r still type.
    expect(keyEvent("down", key("v"))).toMatchObject({ text: "v" });
    expect(keyEvent("down", key("r"))).toMatchObject({ text: "r" });
  });

  it("drops a key name longer than the worker accepts", () => {
    expect(keyEvent("down", { ...none, key: "x".repeat(33), code: "", keyCode: 0 })).toBeNull();
    expect(keyEvent("down", { ...none, key: "x".repeat(32), code: "", keyCode: 0 })).not.toBeNull();
  });
});

describe("address bar and the view's own messages", () => {
  it("navigates to what was typed; the worker checks it is http(s)", () => {
    expect(navTo("  example.com ")).toEqual({ t: "nav", a: "go", url: "example.com" });
    expect(navTo("   ")).toBeNull();
  });

  it("reads the hello and the page meta, and ignores the rest", () => {
    expect(parseLiveText(JSON.stringify({ hello: true, control: true }))).toEqual({ kind: "hello", control: true });
    expect(parseLiveText(JSON.stringify({ hello: 1 }))).toEqual({ kind: "hello", control: false });
    expect(parseLiveText(JSON.stringify({ url: "https://example.com/", title: "Example Domain", tabs: 2 }))).toEqual({
      kind: "meta",
      url: "https://example.com/",
      title: "Example Domain",
      tabs: 2,
    });
    expect(parseLiveText(JSON.stringify({ url: "about:blank" }))).toEqual({ kind: "meta", url: "about:blank", title: "", tabs: 1 });
    expect(parseLiveText("not json")).toEqual({ kind: "other" });
    expect(parseLiveText(JSON.stringify({ something: "else" }))).toEqual({ kind: "other" });
  });

  it("backs off between reconnects, up to 15 s", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    expect(reconnectDelay(-3)).toBe(1000);
  });
});
