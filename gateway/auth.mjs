import { createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "__Host-herdr_session";
export const SESSION_SECONDS = 3600;

function mac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function sameBytes(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readConfig(env) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const allowedUserId = env.TELEGRAM_ALLOWED_USER_ID;
  const sessionSecret = env.HERDR_SESSION_SECRET;
  if (!botToken || !/^\d+:[\w-]{20,}$/.test(botToken))
    throw new Error("Invalid bot credential configuration");
  if (!allowedUserId || !/^[1-9]\d{0,15}$/.test(allowedUserId))
    throw new Error("Invalid owner configuration");
  if (!sessionSecret || sessionSecret.length < 43)
    throw new Error(
      "Session secret must contain at least 32 random bytes encoded as base64url",
    );
  const frontendOrigin = new URL(env.HERDR_FRONTEND_ORIGIN);
  const publicOrigin = new URL(env.HERDR_GATEWAY_ORIGIN);
  for (const url of [frontendOrigin, publicOrigin]) {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Public origins must be HTTPS origins without a path");
    }
  }
  const upstream = new URL(env.HERDR_UPSTREAM ?? "http://127.0.0.1:28787");
  if (
    upstream.protocol !== "http:" ||
    upstream.hostname !== "127.0.0.1" ||
    upstream.pathname !== "/" ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash
  ) {
    throw new Error("Upstream must be a fixed IPv4 loopback HTTP origin");
  }
  const bridgeOrigin = new URL(
    env.HERDR_BRIDGE_ORIGIN ?? "http://127.0.0.1:8788",
  );
  if (
    bridgeOrigin.protocol !== "http:" ||
    bridgeOrigin.hostname !== "127.0.0.1" ||
    bridgeOrigin.href !== bridgeOrigin.origin + "/"
  )
    throw new Error("Bridge origin must be loopback HTTP");
  const port = Number(env.PORT ?? 28788);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid port");
  return {
    botToken,
    allowedUserId,
    sessionSecret,
    frontendOrigin: frontendOrigin.origin,
    publicOrigin: publicOrigin.origin,
    upstream: upstream.origin,
    bridgeOrigin: bridgeOrigin.origin,
    port,
  };
}

export function verifyInitData(
  raw,
  config,
  now = Math.floor(Date.now() / 1000),
) {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > 16384)
    throw new Error("Invalid Telegram authorization");
  // URLSearchParams otherwise silently accepts invalid percent escapes and replaces invalid UTF-8.
  try {
    decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    throw new Error("Invalid Telegram authorization");
  }
  const params = new URLSearchParams(raw);
  const fields = new Map();
  for (const [key, value] of params) {
    if (!/^[a-z_]+$/.test(key) || fields.has(key))
      throw new Error("Invalid Telegram authorization");
    fields.set(key, value);
  }
  const hash = fields.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash))
    throw new Error("Invalid Telegram authorization");
  fields.delete("hash");
  const checkString = [...fields]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = mac("WebAppData", config.botToken);
  if (!sameBytes(mac(secret, checkString), Buffer.from(hash, "hex")))
    throw new Error("Invalid Telegram authorization");
  const authDate = fields.get("auth_date");
  if (!authDate || !/^\d{1,12}$/.test(authDate))
    throw new Error("Invalid Telegram authorization");
  const age = now - Number(authDate);
  if (age < -30 || age > 300)
    throw new Error("Expired Telegram authorization; reopen the Mini App");
  let user;
  try {
    user = JSON.parse(fields.get("user") ?? "null");
  } catch {
    throw new Error("Invalid Telegram authorization");
  }
  if (
    !user ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    String(user.id) !== config.allowedUserId
  )
    throw new Error("Access denied");
  return String(user.id);
}

export function createSession(
  userId,
  config,
  now = Math.floor(Date.now() / 1000),
) {
  const expiresAt = now + SESSION_SECONDS;
  const payload = Buffer.from(JSON.stringify({ userId, expiresAt })).toString(
    "base64url",
  );
  const value = `${payload}.${mac(config.sessionSecret, payload).toString("base64url")}`;
  return {
    value,
    expiresAt,
    cookie: `${COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
  };
}

export function verifySession(
  cookie,
  config,
  now = Math.floor(Date.now() / 1000),
) {
  if (typeof cookie !== "string" || cookie.length > 4096) return null;
  const values = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE_NAME.length + 1);
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  )
    return null;
  const [payload, signature] = parts;
  if (
    !sameBytes(
      mac(config.sessionSecret, payload),
      Buffer.from(signature, "base64url"),
    )
  )
    return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (
      data.userId !== config.allowedUserId ||
      !Number.isInteger(data.expiresAt) ||
      data.expiresAt <= now ||
      data.expiresAt > now + SESSION_SECONDS
    )
      return null;
    return data;
  } catch {
    return null;
  }
}
