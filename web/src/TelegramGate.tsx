import { useEffect, useState, type ReactNode } from "react";
import {
  authenticateTelegram,
  setTelegramAuthorized,
  telegramGatewayOrigin,
  TELEGRAM_AUTH_EXPIRED,
} from "./telegram";

export function TelegramGate({ children }: { children: ReactNode }) {
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!telegramGatewayOrigin) return;
    let cancelled = false;
    const expire = () => {
      setTelegramAuthorized(false);
      setExpiresAt(null);
      setError("Сессия завершена. Закрой и снова открой Herdr в Telegram.");
    };
    window.addEventListener(TELEGRAM_AUTH_EXPIRED, expire);
    void authenticateTelegram()
      .then((expiry) => {
        if (!cancelled) {
          setTelegramAuthorized(true);
          setExpiresAt(expiry);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(
            reason instanceof Error
              ? reason.message
              : "Не удалось подключиться",
          );
      });
    return () => {
      cancelled = true;
      setTelegramAuthorized(false);
      window.removeEventListener(TELEGRAM_AUTH_EXPIRED, expire);
    };
  }, []);
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      () => window.dispatchEvent(new Event(TELEGRAM_AUTH_EXPIRED)),
      Math.max(1, expiresAt * 1000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  if (!telegramGatewayOrigin || (expiresAt && !error)) return children;
  return (
    <main className="telegram-gate">
      <div>
        <h1>Herdr 🖥️</h1>
        <p role={error ? "alert" : "status"}>
          {error ?? "Проверяем Telegram и подключаем твой компьютер…"}
        </p>
        {error && <a href="https://t.me/exdevbot">Открыть @exdevbot</a>}
      </div>
    </main>
  );
}
