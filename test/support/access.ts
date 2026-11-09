import { http, HttpResponse } from "msw";
import { OWNER_EMAIL, testEnv } from "./worker";

export type Claims = Record<string, unknown>;
export const KEY_ID = "access-test-key";
export const ROTATED_KEY_ID = "access-rotated-key";
const algorithm = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};
let keys: Promise<{ pair: CryptoKeyPair; foreign: CryptoKeyPair }> | undefined;
function testKeys() {
  return (keys ??= (async () => ({
    pair: await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]),
    foreign: await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]),
  }))());
}

export async function accessJwks(rotated = false) {
  const { pair, foreign } = await testKeys();
  const jwk = await crypto.subtle.exportKey("jwk", (rotated ? foreign : pair).publicKey);
  return { keys: [{ ...jwk, kid: rotated ? ROTATED_KEY_ID : KEY_ID, alg: "RS256", use: "sig" }] };
}

export const access = {
  mode: "ok" as "ok" | "slow" | "fail" | "junk" | "invalid-key" | "invalid-json" | "redirect",
  rotated: false,
  requests: [] as Request[],
  releases: [] as Array<() => void>,
  release() {
    for (const release of this.releases) release();
    this.releases.length = 0;
  },
  reset() {
    this.release();
    this.mode = "ok";
    this.rotated = false;
    this.requests.length = 0;
  },
  handlers() {
    return [
      http.get(
        /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/cdn-cgi\/access\/certs$/,
        async ({ request }) => {
          this.requests.push(request);
          if (this.mode === "slow")
            await new Promise<void>((resolve) => this.releases.push(resolve));
          if (this.mode === "fail") return new HttpResponse(null, { status: 503 });
          if (this.mode === "junk") return HttpResponse.json({ message: "not a key set" });
          if (this.mode === "invalid-key")
            return HttpResponse.json({ keys: [{ kid: KEY_ID, kty: "RSA", n: "!", e: "!" }] });
          if (this.mode === "invalid-json") return new HttpResponse("not json");
          if (this.mode === "redirect")
            return new HttpResponse(null, {
              status: 302,
              headers: { Location: "https://untrusted.example/certs" },
            });
          return HttpResponse.json(await accessJwks(this.rotated));
        },
      ),
    ];
  },
};

const bytes = (value: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const encode = (value: unknown) => bytes(new TextEncoder().encode(JSON.stringify(value)).buffer);

/** Real signatures from test-only keys. Undefined claims are omitted, including required claims. */
export async function signAccessJwt(
  overrides: Claims = {},
  header: { alg?: string; kid?: string; foreign?: boolean } = {},
) {
  const { pair, foreign } = await testKeys();
  const now = Math.floor(Date.now() / 1000);
  const config = testEnv();
  const payload = {
    iss: config.ACCESS_ISSUER,
    aud: [config.ACCESS_AUDIENCE],
    email: OWNER_EMAIL,
    iat: now - 1,
    nbf: now - 1,
    exp: now + 3600,
    sub: "access-owner",
    ...overrides,
  };
  const alg = header.alg ?? "RS256";
  const partial = `${encode({ alg, kid: header.kid ?? KEY_ID, typ: "JWT" })}.${encode(payload)}`;
  if (alg === "none") return `${partial}.`;
  const key =
    alg === "HS256"
      ? await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode("test-only-hmac-secret"),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        )
      : (header.foreign ? foreign : pair).privateKey;
  const signature = await crypto.subtle.sign(
    alg === "HS256" ? "HMAC" : algorithm.name,
    key,
    new TextEncoder().encode(partial),
  );
  return `${partial}.${bytes(signature)}`;
}
