/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewRows, PreviewSurface } from "./PreviewSurface";
import {
  initialPreviewState,
  previewReducer,
  parsePreviewSnapshot,
  type usePreviews,
} from "./previews";

vi.mock("./previews", async (original) => ({
  ...(await original<typeof import("./previews")>()),
  launchPreview: vi.fn(
    async (id: string, domain: string) =>
      `https://p-${id}.${domain}/__herdr_launch?ticket=synthetic`,
  ),
}));
const id = "a".repeat(32),
  other = "b".repeat(32);
const entries = [id, other].map((value, index) => ({
  id: value,
  name: `App ${index}`,
  workspaceId: "w1",
  port: 5173 + index,
  path: "/",
  available: true,
}));
const roots: Root[] = [];
afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let state = previewReducer(initialPreviewState(), {
    type: "snapshot",
    value: parsePreviewSnapshot({
      epoch: "e".repeat(32),
      revision: 1,
      domain: "preview.example.test",
      previews: entries,
      lastOpen: { id, revision: 1 },
    }),
  });
  const close = vi.fn(async () => {}),
    back = vi.fn(),
    menu = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  async function render() {
    const previews: ReturnType<typeof usePreviews> = {
      ...state,
      error: null,
      closingIds: [],
      close,
      enabled: true,
      select: vi.fn(),
      refresh: vi.fn(),
    };
    await act(async () => {
      root.render(
        <>
          <PreviewRows
            entries={entries}
            previews={previews}
            onSelect={vi.fn()}
          />
          <PreviewSurface
            previews={previews}
            onBack={back}
            onMenu={menu}
            compact={true}
            spaceLabel="Workspace"
          />
        </>,
      );
    });
  }
  return {
    container,
    close,
    back,
    render,
    async select(value: string | null) {
      state = previewReducer(state, { type: "select", id: value });
      await render();
    },
    async remove(value: string) {
      state = previewReducer(state, {
        type: "closed",
        id: value,
        revision: 2,
        epoch: "e".repeat(32),
      });
      await render();
    },
  };
}
describe("compact embedded preview surface", () => {
  it("retains iframe identity over two terminal/other-preview cycles and removes it only on close", async () => {
    const ui = setup();
    await ui.render();
    const first = ui.container.querySelector("iframe");
    expect(first).not.toBeNull();
    for (let cycle = 0; cycle < 2; cycle++) {
      await ui.select(null);
      expect(
        ui.container.querySelector(".preview-stage")?.hasAttribute("hidden"),
      ).toBe(true);
      await ui.select(other);
      await ui.select(id);
      expect(ui.container.querySelector("iframe")).toBe(first);
    }
    expect(ui.container.querySelectorAll("iframe")).toHaveLength(2);
    expect(first?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms",
    );
    expect(first?.getAttribute("referrerpolicy")).toBe("no-referrer");
    await ui.remove(id);
    expect(first?.isConnected).toBe(false);
    expect(ui.container.querySelectorAll("iframe")).toHaveLength(1);
  });
  it("row cross and compact header cross call the same close contract; return does not close", async () => {
    const ui = setup();
    await ui.render();
    await act(async () => {
      ui.container
        .querySelector<HTMLButtonElement>('[aria-label="Close preview App 0"]')
        ?.click();
      ui.container
        .querySelector<HTMLButtonElement>('[aria-label="Close preview"]')
        ?.click();
      ui.container
        .querySelector<HTMLButtonElement>('[aria-label="Return to terminal"]')
        ?.click();
    });
    expect(ui.close.mock.calls).toEqual([[id], [id]]);
    expect(ui.back).toHaveBeenCalledOnce();
  });
});
