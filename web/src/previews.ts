import { useCallback, useEffect, useReducer, useState } from "react";
import { bridgeFetch, telegramGatewayOrigin } from "./telegram";

const ID = /^[a-f0-9]{32}$/;
function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid preview response");
  return value;
}
export function parsePreviewEntry(value: unknown) {
  const entry = object(value);
  if (
    !("id" in entry) ||
    typeof entry.id !== "string" ||
    !ID.test(entry.id) ||
    !("name" in entry) ||
    typeof entry.name !== "string" ||
    !entry.name ||
    entry.name.length > 80 ||
    !("port" in entry) ||
    typeof entry.port !== "number" ||
    !Number.isInteger(entry.port) ||
    entry.port < 1024 ||
    entry.port > 65535 ||
    !("workspaceId" in entry) ||
    typeof entry.workspaceId !== "string" ||
    !("path" in entry) ||
    typeof entry.path !== "string" ||
    !entry.path.startsWith("/") ||
    entry.path.startsWith("//") ||
    !("available" in entry) ||
    typeof entry.available !== "boolean"
  )
    throw new Error("Invalid preview entry");
  return {
    id: entry.id,
    name: entry.name,
    port: entry.port,
    workspaceId: entry.workspaceId,
    path: entry.path,
    available: entry.available,
  };
}
export type PreviewEntry = ReturnType<typeof parsePreviewEntry>;
export function parsePreviewSnapshot(value: unknown) {
  const snapshot = object(value);
  if (
    !("epoch" in snapshot) ||
    typeof snapshot.epoch !== "string" ||
    !ID.test(snapshot.epoch) ||
    !("revision" in snapshot) ||
    typeof snapshot.revision !== "number" ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    !("domain" in snapshot) ||
    typeof snapshot.domain !== "string" ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(snapshot.domain) ||
    !("previews" in snapshot) ||
    !Array.isArray(snapshot.previews) ||
    snapshot.previews.length > 8 ||
    !("lastOpen" in snapshot)
  )
    throw new Error("Invalid preview snapshot");
  const previews = snapshot.previews.map(parsePreviewEntry);
  if (new Set(previews.map((entry) => entry.id)).size !== previews.length)
    throw new Error("Duplicate preview ID");
  let lastOpen: { id: string; revision: number } | null = null;
  if (snapshot.lastOpen !== null) {
    const open = object(snapshot.lastOpen);
    if (
      !("id" in open) ||
      typeof open.id !== "string" ||
      !previews.some((entry) => entry.id === open.id) ||
      !("revision" in open) ||
      typeof open.revision !== "number" ||
      !Number.isSafeInteger(open.revision) ||
      open.revision < 1 ||
      open.revision > snapshot.revision
    )
      throw new Error("Invalid preview open request");
    lastOpen = { id: open.id, revision: open.revision };
  }
  return {
    epoch: snapshot.epoch,
    revision: snapshot.revision,
    domain: snapshot.domain,
    previews,
    lastOpen,
  };
}
export type PreviewSnapshot = ReturnType<typeof parsePreviewSnapshot>;
export function shouldRevealPreviewDetail(
  previous: { selectedId: string | null; compact: boolean; seenOpen: number },
  current: typeof previous,
) {
  return Boolean(
    current.selectedId &&
    current.compact &&
    (current.selectedId !== previous.selectedId ||
      !previous.compact ||
      current.seenOpen > previous.seenOpen),
  );
}
export function initialPreviewState() {
  return {
    snapshot: null as PreviewSnapshot | null,
    selectedId: null as string | null,
    retainedIds: [] as string[],
    seenOpen: 0,
    revision: -1,
  };
}
type PreviewAction =
  | { type: "snapshot"; value: PreviewSnapshot }
  | { type: "select"; id: string | null }
  | { type: "closed"; id: string; revision: number; epoch: string };
function retain(ids: string[], id: string) {
  return ids.includes(id) ? ids : [...ids, id];
}
export function previewReducer(
  state: ReturnType<typeof initialPreviewState>,
  action: PreviewAction,
) {
  if (action.type === "select") {
    if (
      action.id &&
      !state.snapshot?.previews.some((entry) => entry.id === action.id)
    )
      return state;
    return {
      ...state,
      selectedId: action.id,
      retainedIds: action.id
        ? retain(state.retainedIds, action.id)
        : state.retainedIds,
    };
  }
  if (action.type === "closed") {
    if (action.epoch !== state.snapshot?.epoch) return state;
    return {
      ...state,
      selectedId: state.selectedId === action.id ? null : state.selectedId,
      retainedIds: state.retainedIds.filter((id) => id !== action.id),
      revision: Math.max(state.revision, action.revision),
      snapshot: state.snapshot
        ? {
            ...state.snapshot,
            previews: state.snapshot.previews.filter(
              (entry) => entry.id !== action.id,
            ),
          }
        : null,
    };
  }
  const snapshot = action.value;
  const sameEpoch = state.snapshot?.epoch === snapshot.epoch;
  if (sameEpoch && snapshot.revision < state.revision) return state;
  const seenOpen = sameEpoch ? state.seenOpen : 0;
  const exists = (id: string) =>
    snapshot.previews.some((entry) => entry.id === id);
  let selectedId =
    state.selectedId && exists(state.selectedId) ? state.selectedId : null;
  let retainedIds = state.retainedIds.filter(exists);
  if (snapshot.lastOpen && snapshot.lastOpen.revision > seenOpen) {
    selectedId = snapshot.lastOpen.id;
    retainedIds = retain(retainedIds, selectedId);
  }
  return {
    snapshot,
    selectedId,
    retainedIds,
    revision: snapshot.revision,
    seenOpen: Math.max(seenOpen, snapshot.lastOpen?.revision ?? 0),
  };
}
export function parsePreviewLaunch(value: unknown, id: string, domain: string) {
  const launch = object(value);
  if (!("url" in launch) || typeof launch.url !== "string")
    throw new Error("Invalid preview launch");
  const url = new URL(launch.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== `p-${id}.${domain}` ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== "/__herdr_launch" ||
    !url.searchParams.get("ticket")
  )
    throw new Error("Invalid preview launch origin");
  return url.href;
}
export async function launchPreview(
  id: string,
  domain: string,
  signal: AbortSignal,
) {
  if (!telegramGatewayOrigin || !ID.test(id))
    throw new Error("Private Telegram gateway is required");
  const response = await bridgeFetch(
    `${telegramGatewayOrigin}/api/previews/${id}/launch`,
    { method: "POST", signal },
  );
  if (!response.ok)
    throw new Error("Не удалось открыть превью. Попробуй снова.");
  return parsePreviewLaunch(await response.json(), id, domain);
}
export function usePreviews() {
  const [state, dispatch] = useReducer(
    previewReducer,
    undefined,
    initialPreviewState,
  );
  const [error, setError] = useState<string | null>(null);
  const [closingIds, setClosingIds] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!telegramGatewayOrigin) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let requested = new URL(globalThis.location.href).searchParams.get(
      "preview",
    );
    if (requested && !ID.test(requested)) requested = null;
    async function poll() {
      try {
        const response = await bridgeFetch(
          `${telegramGatewayOrigin}/api/previews`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(6000),
            ]),
          },
        );
        if (!response.ok)
          throw new Error("Превью на компьютере пока недоступны.");
        const snapshot = parsePreviewSnapshot(await response.json());
        if (controller.signal.aborted) return;
        dispatch({ type: "snapshot", value: snapshot });
        if (
          requested &&
          snapshot.previews.some((entry) => entry.id === requested)
        ) {
          dispatch({ type: "select", id: requested });
          requested = null;
          const url = new URL(globalThis.location.href);
          url.searchParams.delete("preview");
          globalThis.history.replaceState(globalThis.history.state, "", url);
        }
        setError(null);
      } catch {
        if (!controller.signal.aborted)
          setError("Не удалось связаться с превью на компьютере.");
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 1800);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);
  const close = useCallback(async (id: string) => {
    if (!telegramGatewayOrigin || !ID.test(id)) return;
    setClosingIds((ids) => [...ids, id]);
    try {
      const response = await bridgeFetch(
        `${telegramGatewayOrigin}/api/previews/close`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
          signal: AbortSignal.timeout(6000),
        },
      );
      if (!response.ok) throw new Error();
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== "object" ||
        !("revision" in result) ||
        typeof result.revision !== "number" ||
        !Number.isSafeInteger(result.revision) ||
        result.revision < 0 ||
        !("epoch" in result) ||
        typeof result.epoch !== "string" ||
        !ID.test(result.epoch) ||
        !("id" in result) ||
        result.id !== id
      )
        throw new Error();
      dispatch({
        type: "closed",
        id,
        revision: result.revision,
        epoch: result.epoch,
      });
      setError(null);
      setRefresh((value) => value + 1);
    } catch {
      setError("Не удалось закрыть превью. Попробуй снова.");
    } finally {
      setClosingIds((ids) => ids.filter((value) => value !== id));
    }
  }, []);
  return {
    ...state,
    error,
    closingIds,
    close,
    enabled: Boolean(telegramGatewayOrigin),
    select: (id: string | null) => dispatch({ type: "select", id }),
    refresh: () => setRefresh((value) => value + 1),
  };
}
