import { createHmac } from "node:crypto";
import { readConfig } from "./auth.mjs";

export const env = {
  TELEGRAM_BOT_TOKEN: "123456:synthetic_test_credential_only",
  TELEGRAM_ALLOWED_USER_ID: "42",
  HERDR_SESSION_SECRET:
    "synthetic-test-session-secret-not-used-in-production-123",
  HERDR_FRONTEND_ORIGIN: "https://app.example.test",
  HERDR_GATEWAY_ORIGIN: "https://gateway.example.test",
};
export const config = readConfig(env);
export function signedData({
  id = 42,
  date = Math.floor(Date.now() / 1000),
  user = JSON.stringify({ id, first_name: "Test" }),
} = {}) {
  const params = new URLSearchParams({
    auth_date: String(date),
    user,
    query_id: "synthetic",
  });
  const secret = createHmac("sha256", "WebAppData")
    .update(env.TELEGRAM_BOT_TOKEN)
    .digest();
  const check = [...params]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}
