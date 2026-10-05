import { describe, expect, it } from "vitest";
import {
  initialPreviewState,
  parsePreviewEntry,
  parsePreviewLaunch,
  parsePreviewSnapshot,
  previewReducer,
  shouldRevealPreviewDetail,
} from "./previews";

const id = "a".repeat(32),
  other = "b".repeat(32),
  epoch = "e".repeat(32);
const entry = {
  id,
  name: "Notes",
  port: 5173,
  workspaceId: "w1",
  path: "/",
  available: true,
};
function snapshot(
  revision = 1,
  entries = [entry],
  lastOpen: { id: string; revision: number } | null = { id, revision },
) {
  return parsePreviewSnapshot({
    epoch,
    revision,
    previews: entries,
    lastOpen,
    domain: "preview.example.test",
  });
}
describe("private preview navigation contract", () => {
  it("mobile open requests reveal an existing preview but polling respects the workspace list", () => {
    const previous = { selectedId: id, compact: true, seenOpen: 1 };
    expect(shouldRevealPreviewDetail(previous, previous)).toBe(false);
    expect(
      shouldRevealPreviewDetail(previous, { ...previous, seenOpen: 2 }),
    ).toBe(true);
    expect(
      shouldRevealPreviewDetail({ ...previous, compact: false }, previous),
    ).toBe(true);
    expect(
      shouldRevealPreviewDetail(previous, {
        ...previous,
        selectedId: null,
        seenOpen: 2,
      }),
    ).toBe(false);
    expect(
      shouldRevealPreviewDetail(previous, { ...previous, selectedId: other }),
    ).toBe(true);
  });
  it("validates server metadata without exposing arbitrary iframe URLs", () => {
    expect(parsePreviewEntry(entry)).toEqual(entry);
    for (const invalid of [
      { ...entry, id: "../../outside" },
      { ...entry, available: "yes" },
      { ...entry, port: 80 },
      { ...entry, path: "//outside.test" },
    ])
      expect(() => parsePreviewEntry(invalid)).toThrow();
    expect(() =>
      parsePreviewSnapshot({ ...snapshot(), previews: [entry, entry] }),
    ).toThrow();
    expect(() =>
      parsePreviewSnapshot({
        ...snapshot(),
        lastOpen: { id: other, revision: 1 },
      }),
    ).toThrow();
  });
  it("opens a new agent request once, then respects returning to terminal", () => {
    let state = previewReducer(initialPreviewState(), {
      type: "snapshot",
      value: snapshot(),
    });
    expect(state.selectedId).toBe(id);
    state = previewReducer(state, { type: "select", id: null });
    state = previewReducer(state, { type: "snapshot", value: snapshot() });
    expect(state.selectedId).toBeNull();
    expect(state.retainedIds).toEqual([id]);
    state = previewReducer(state, { type: "snapshot", value: snapshot(2) });
    expect(state.selectedId).toBe(id);
  });
  it("retains visited frames through agent/preview switches without silent draft eviction", () => {
    let state = previewReducer(initialPreviewState(), {
      type: "snapshot",
      value: snapshot(1, [entry, { ...entry, id: other, workspaceId: "w2" }]),
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      state = previewReducer(state, { type: "select", id: other });
      state = previewReducer(state, { type: "select", id: null });
      state = previewReducer(state, { type: "select", id });
      expect(new Set(state.retainedIds)).toEqual(new Set([id, other]));
    }
    expect(previewReducer(state, { type: "select", id: "c".repeat(32) })).toBe(
      state,
    );
  });
  it("close removes its frame/selection and ignores a late pre-close snapshot", () => {
    const state = previewReducer(initialPreviewState(), {
      type: "snapshot",
      value: snapshot(),
    });
    const closed = previewReducer(state, {
      type: "closed",
      id,
      revision: 2,
      epoch,
    });
    expect(closed.selectedId).toBeNull();
    expect(closed.retainedIds).toEqual([]);
    expect(closed.snapshot?.previews).toEqual([]);
    expect(
      previewReducer(closed, { type: "snapshot", value: snapshot() }),
    ).toBe(closed);
  });
  it("accepts availability changes at the same revision without reselecting a hidden frame", () => {
    let state = previewReducer(initialPreviewState(), {
      type: "snapshot",
      value: snapshot(),
    });
    state = previewReducer(state, { type: "select", id: null });
    state = previewReducer(state, {
      type: "snapshot",
      value: snapshot(1, [{ ...entry, available: false }]),
    });
    expect(state.selectedId).toBeNull();
    expect(state.snapshot?.previews[0].available).toBe(false);
    expect(state.retainedIds).toEqual([id]);
  });
  it("registry replacement clears stale frames even when the new revision starts lower", () => {
    const state = previewReducer(initialPreviewState(), {
      type: "snapshot",
      value: snapshot(100),
    });
    const replacement = parsePreviewSnapshot({
      epoch: "f".repeat(32),
      revision: 0,
      domain: "preview.example.test",
      previews: [],
      lastOpen: null,
    });
    const replaced = previewReducer(state, {
      type: "snapshot",
      value: replacement,
    });
    expect(replaced.selectedId).toBeNull();
    expect(replaced.retainedIds).toEqual([]);
    expect(
      previewReducer(replaced, { type: "closed", id, revision: 101, epoch }),
    ).toBe(replaced);
  });
  it("enforces a finite registration/frame bound", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      ...entry,
      id: index.toString(16).padStart(32, "0"),
    }));
    expect(snapshot(1, entries, null).previews).toHaveLength(8);
    expect(() =>
      snapshot(1, [...entries, { ...entry, id: other }], null),
    ).toThrow();
  });
  it("accepts only the expected per-preview HTTPS bootstrap origin", () => {
    const url = `https://p-${id}.preview.example.test/__herdr_launch?ticket=synthetic`;
    expect(parsePreviewLaunch({ url }, id, "preview.example.test")).toBe(url);
    for (const invalid of [
      url.replace("https:", "http:"),
      url.replace(id, other),
      url.replace("preview.example.test", "evil.test"),
      url.replace("/__herdr_launch", "/api/snapshot"),
      url.replace("https://", "https://user@"),
    ])
      expect(() =>
        parsePreviewLaunch({ url: invalid }, id, "preview.example.test"),
      ).toThrow();
  });
});
