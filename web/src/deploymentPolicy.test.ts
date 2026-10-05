import { describe, expect, it } from "vitest";
import deployment from "../vercel.json";

const headers = deployment.headers.find(
  (entry) => entry.source === "/(.*)",
)?.headers;
const policy = headers?.find(
  (header) => header.key.toLowerCase() === "content-security-policy",
)?.value;
if (!policy) throw new Error("Deployment security policy missing");
const directives = new Map(
  policy.split(";").map((entry) => {
    const [name, ...sources] = entry.trim().split(/\s+/u);
    return [name, sources];
  }),
);

function allowsConnection(input: string) {
  const url = new URL(input);
  const sources =
    directives.get("connect-src") ?? directives.get("default-src") ?? [];
  return (
    sources.includes(url.protocol) ||
    sources.includes(url.origin) ||
    (url.origin === "https://herdr.peacedata.company" &&
      sources.includes("'self'"))
  );
}

describe("production renderer deployment contract", () => {
  it("allows the bundled Ghostty WASM data fetch and WebAssembly compilation", () => {
    // Ghostty embeds its WASM in a data URL and loads it with fetch before compiling it.
    expect(allowsConnection("data:application/wasm;base64,AGFzbQEAAAA=")).toBe(
      true,
    );
    expect(directives.get("script-src")).toContain("'wasm-unsafe-eval'");
  });
  it("retains only the serving origin and configured gateway for network connections", () => {
    expect(
      allowsConnection("https://herdr.peacedata.company/assets/renderer.js"),
    ).toBe(true);
    expect(
      allowsConnection("https://herdr-gateway.peacedata.company/api/snapshot"),
    ).toBe(true);
    expect(
      allowsConnection("wss://herdr-gateway.peacedata.company/ws/terminal"),
    ).toBe(true);
    expect(allowsConnection("https://untrusted.example/api/snapshot")).toBe(
      false,
    );
    expect(directives.get("connect-src")).not.toContain("*");
    expect(directives.get("script-src")).not.toContain("'unsafe-eval'");
  });
});
