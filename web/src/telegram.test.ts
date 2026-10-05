// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

async function telegram(mode = true) {
  vi.resetModules();
  vi.stubEnv(
    "VITE_TELEGRAM_GATEWAY_URL",
    mode ? "https://gateway.example.test" : "",
  );
  return import("./telegram");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete window.Telegram;
});

describe("optional Telegram transport", () => {
  it("preserves standalone fetch and URL behavior", async () => {
    const api = await telegram(false);
    const fetcher = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetcher);
    await api.bridgeFetch("/api/snapshot", { method: "GET" });
    expect(fetcher).toHaveBeenCalledWith("/api/snapshot", { method: "GET" });
    expect(api.telegramBridgeBaseUrl("http://lan:4000")).toBe(
      "http://lan:4000",
    );
  });
  it("fails closed before login and refuses other bridge origins", async () => {
    const api = await telegram();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      api.bridgeFetch("https://gateway.example.test/api/snapshot"),
    ).rejects.toThrow();
    api.setTelegramAuthorized(true);
    await expect(
      api.bridgeFetch("https://evil.example.test/api/snapshot"),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(api.telegramBridgeBaseUrl("http://lan:4000")).toBe(
      "https://gateway.example.test",
    );
  });
  it("sends credentials only to gateway and signals session expiry", async () => {
    const api = await telegram();
    api.setTelegramAuthorized(true);
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const expired = vi.fn();
    window.addEventListener(api.TELEGRAM_AUTH_EXPIRED, expired, { once: true });
    await api.bridgeFetch("https://gateway.example.test/api/snapshot");
    expect(fetcher).toHaveBeenCalledWith(
      "https://gateway.example.test/api/snapshot",
      { credentials: "include" },
    );
    expect(expired).toHaveBeenCalledOnce();
    await expect(
      api.bridgeFetch("https://gateway.example.test/api/snapshot"),
    ).rejects.toThrow();
  });
  it("exchanges raw SDK initData and does not trust unsafe identity", async () => {
    const api = await telegram();
    const ready = vi.fn();
    const expand = vi.fn();
    window.Telegram = {
      WebApp: { initData: "synthetic-signed-data", ready, expand },
    };
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ expiresAt: expiry })));
    vi.stubGlobal("fetch", fetcher);
    expect(await api.authenticateTelegram()).toBe(expiry);
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://gateway.example.test/auth/login",
    );
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      initData: "synthetic-signed-data",
    });
    expect(fetcher.mock.calls[0][1].credentials).toBe("include");
    expect(ready).toHaveBeenCalledOnce();
    expect(expand).toHaveBeenCalledOnce();
  });
  it("does not request gateway without signed Telegram data", async () => {
    const api = await telegram();
    window.Telegram = { WebApp: { initData: "" } };
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(api.authenticateTelegram()).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects non-HTTPS or credentialed gateway configuration", async () => {
    const api = await telegram();
    for (const value of [
      "http://gateway.test",
      "https://user:secret@gateway.test",
      "https://gateway.test/path",
      "https://gateway.test?token=x",
    ]) {
      expect(() => api.parseTelegramGatewayOrigin(value)).toThrow();
    }
  });
});
