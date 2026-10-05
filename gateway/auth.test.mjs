import test from "node:test";
import assert from "node:assert/strict";
import {
  readConfig,
  verifyInitData,
  createSession,
  verifySession,
} from "./auth.mjs";
import { env, config, signedData } from "./fixtures.mjs";

test("valid signed owner and session roundtrip; cookie security flags", () => {
  assert.equal(verifyInitData(signedData({ date: 1000 }), config, 1000), "42");
  const session = createSession("42", config, 1000);
  assert.deepEqual(verifySession(session.cookie, config, 1001), {
    userId: "42",
    expiresAt: 4600,
  });
  assert.match(session.cookie, /Secure; HttpOnly; SameSite=Strict/);
  assert.ok(!session.cookie.includes("Domain="));
});

test("tampering, wrong user, malformed and duplicate fields denied", () => {
  const good = signedData({ date: 1000 });
  for (const raw of [
    good.replace("synthetic", "tampered"),
    signedData({ id: 43, date: 1000 }),
    good + "&user=x",
    good + "&hash=x",
    good + "&bad=%ZZ",
    "",
    "user=wrong",
    signedData({ user: "null", date: 1000 }),
    signedData({ user: "{bad}", date: 1000 }),
  ]) {
    assert.throws(() => verifyInitData(raw, config, 1000));
  }
});

test("expired/future auth and session tampering/expiry denied", () => {
  assert.throws(() => verifyInitData(signedData({ date: 699 }), config, 1000));
  assert.throws(() => verifyInitData(signedData({ date: 1031 }), config, 1000));
  const s = createSession("42", config, 1000);
  assert.equal(verifySession(s.cookie, config, 4600), null);
  assert.equal(
    verifySession(s.cookie.replace(s.value, s.value + "x"), config, 1001),
    null,
  );
  assert.equal(verifySession(s.cookie + "; " + s.cookie, config, 1001), null);
  assert.equal(
    verifySession(createSession("43", config, 1000).cookie, config, 1001),
    null,
  );
  assert.equal(verifySession(undefined, config, 1001), null);
});

test("configuration fails closed; no remote proxy target", () => {
  for (const field of [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USER_ID",
    "HERDR_SESSION_SECRET",
    "HERDR_FRONTEND_ORIGIN",
    "HERDR_GATEWAY_ORIGIN",
  ]) {
    assert.throws(() => readConfig({ ...env, [field]: "" }));
  }
  for (const value of [
    "http://example.test",
    "http://127.0.0.1/path",
    "http://user:pass@127.0.0.1",
  ])
    assert.throws(() => readConfig({ ...env, HERDR_UPSTREAM: value }));
});
