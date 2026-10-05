/// <reference types="vite/client" />

export function parseTelegramGatewayOrigin(value: unknown) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string")
    throw new Error("Invalid Telegram gateway configuration");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Telegram gateway must be an HTTPS origin");
  }
  return url.origin;
}

export const telegramGatewayOrigin = parseTelegramGatewayOrigin(
  import.meta.env.VITE_TELEGRAM_GATEWAY_URL,
);
export const TELEGRAM_AUTH_EXPIRED = "herdr:telegram-auth-expired";
let authorized = false;

export function setTelegramAuthorized(value: boolean) {
  authorized = value;
}

export async function bridgeFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
) {
  if (!telegramGatewayOrigin) return fetch(input, init);
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    globalThis.location.href,
  );
  if (
    url.origin !== telegramGatewayOrigin ||
    !url.pathname.startsWith("/api/") ||
    !authorized
  ) {
    throw new Error("Authenticated Telegram gateway required");
  }
  const response = await fetch(input, { ...init, credentials: "include" });
  if (response.status === 401) {
    authorized = false;
    globalThis.dispatchEvent(new Event(TELEGRAM_AUTH_EXPIRED));
  }
  return response;
}

export function telegramBridgeBaseUrl(baseUrl: string | null) {
  return telegramGatewayOrigin ?? baseUrl;
}

type TelegramWebApp = {
  initData: string;
  ready?: () => void;
  expand?: () => void;
  disableVerticalSwipes?: () => void;
  enableClosingConfirmation?: () => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

let sdkPromise: Promise<void> | undefined;
export async function loadTelegramSdk() {
  if (window.Telegram?.WebApp) return;
  sdkPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-web-app.js";
    script.async = true;
    const timer = setTimeout(
      () => reject(new Error("Telegram SDK unavailable")),
      10000,
    );
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Telegram SDK unavailable"));
    };
    document.head.append(script);
  });
  await sdkPromise;
}

export async function authenticateTelegram() {
  if (!telegramGatewayOrigin)
    throw new Error("Telegram mode is not configured");
  await loadTelegramSdk();
  const app = window.Telegram?.WebApp;
  if (!app?.initData)
    throw new Error(
      "Открой Herdr кнопкой в @exdevbot — доступ доступен только владельцу.",
    );
  app.ready?.();
  app.expand?.();
  app.disableVerticalSwipes?.();
  app.enableClosingConfirmation?.();
  const response = await fetch(`${telegramGatewayOrigin}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: app.initData }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(
      "Доступ запрещён или авторизация истекла. Закрой и снова открой приложение в Telegram.",
    );
  const payload: unknown = await response.json();
  if (
    !payload ||
    typeof payload !== "object" ||
    !("expiresAt" in payload) ||
    typeof payload.expiresAt !== "number" ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt * 1000 <= Date.now()
  ) {
    throw new Error("Некорректный ответ авторизации");
  }
  return payload.expiresAt;
}
