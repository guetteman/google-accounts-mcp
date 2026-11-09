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
let weak: Promise<CryptoKeyPair> | undefined;
async function weakJwks() {
  weak ??= crypto.subtle.generateKey({ ...algorithm, modulusLength: 1024 }, true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;
  const jwk = await crypto.subtle.exportKey("jwk", (await weak).publicKey);
  return { keys: [{ ...jwk, kid: KEY_ID, alg: "RS256", use: "sig" }] };
}

export async function accessJwks(rotated = false, alg = "RS256") {
  const { pair, foreign } = await testKeys();
  const jwk = await crypto.subtle.exportKey("jwk", (rotated ? foreign : pair).publicKey);
  return { keys: [{ ...jwk, kid: rotated ? ROTATED_KEY_ID : KEY_ID, alg, use: "sig" }] };
}

/** A 256-byte modulus whose top byte is 0x01: 2041 bits, one byte from looking like 2048. */
async function shortJwks() {
  const [key] = (await accessJwks()).keys;
  if (!key?.n) throw new Error("the test key has no modulus");
  const n = Uint8Array.from(atob(key.n.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
  n[0] = 0x01;
  return { keys: [{ ...key, n: bytes(n.buffer) }] };
}

export const access = {
  mode: "ok" as
    | "ok"
    | "slow"
    | "fail"
    | "junk"
    | "invalid-key"
    | "weak-key"
    | "no-kty"
    | "short-key"
    | "invalid-json"
    | "redirect",
  rotated: false,
  keyAlgorithm: "RS256",
  requests: [] as Array<Pick<Request, "url" | "signal">>,
  releases: [] as Array<() => void>,
  release() {
    for (const release of this.releases) release();
    this.releases.length = 0;
  },
  reset() {
    this.release();
    this.mode = "ok";
    this.rotated = false;
    this.keyAlgorithm = "RS256";
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
          if (this.mode === "weak-key") return HttpResponse.json(await weakJwks());
          if (this.mode === "short-key") return HttpResponse.json(await shortJwks());
          if (this.mode === "no-kty") {
            const { keys } = await accessJwks();
            return HttpResponse.json({ keys: keys.map(({ kty: _kty, ...key }) => key) });
          }
          if (this.mode === "invalid-json") return new HttpResponse("not json");
          if (this.mode === "redirect")
            return new HttpResponse(null, {
              status: 302,
              headers: { Location: "https://untrusted.example/certs" },
            });
          return HttpResponse.json(await accessJwks(this.rotated, this.keyAlgorithm));
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
  let key =
    alg === "HS256"
      ? await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode("test-only-hmac-secret"),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        )
      : (header.foreign ? foreign : pair).privateKey;
  if (alg === "RS512") {
    key = await crypto.subtle.importKey(
      "pkcs8",
      await crypto.subtle.exportKey("pkcs8", key),
      { name: algorithm.name, hash: "SHA-512" },
      false,
      ["sign"],
    );
  }
  const signature = await crypto.subtle.sign(
    alg === "HS256" ? "HMAC" : algorithm.name,
    key,
    new TextEncoder().encode(partial),
  );
  return `${partial}.${bytes(signature)}`;
}
