// Plaid webhook receiver — Queer Pathways
// Netlify Functions v2. Save at netlify/functions/plaid-webhook.mjs
//
// Env vars: PLAID_CLIENT_ID, PLAID_SECRET (secret), PLAID_HOST (optional, defaults to sandbox).
//
// Two things make a Plaid webhook unlike any other. All traffic arrives from a single IP, so
// allowlisting proves nothing and this verification is the only gate. And Plaid's key endpoint
// returns a JWK, not a PEM: handing that to verify() as a PEM throws ERR_OSSL_UNSUPPORTED.
// An ES256 JWS signature is raw r||s, so dsaEncoding must be ieee-p1363 (Node's default is DER).

import { verify, createHash, createPublicKey } from "node:crypto";

const MAX_BODY_BYTES = 200 * 1024;
const MAX_IAT_SKEW_MS = 5 * 60 * 1000;

// Sandbox credentials are rejected by the production host, so this follows the environment.
// Accepts either "sandbox.plaid.com" or a full "https://sandbox.plaid.com".
const PLAID_HOST = process.env.PLAID_HOST || "sandbox.plaid.com";
const PLAID_BASE = /^https?:\/\//.test(PLAID_HOST) ? PLAID_HOST.replace(/\/$/, "") : `https://${PLAID_HOST}`;
const EVENT_STORE = "qp-plaid-events";

const b64urlToBuffer = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function decodeJwt(token) {
  const [h, p, sig] = token.split(".");
  return {
    header: JSON.parse(b64urlToBuffer(h).toString("utf8")),
    payload: JSON.parse(b64urlToBuffer(p).toString("utf8")),
    signingInput: `${h}.${p}`,
    signature: b64urlToBuffer(sig),
  };
}

// Fetched per kid and cached as KeyObjects.
const keyCache = new Map();
async function keyFor(kid) {
  if (keyCache.has(kid)) return keyCache.get(kid);

  const res = await fetch(`${PLAID_BASE}/webhook_verification_key/get`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      key_id: kid,
    }),
  });

  const body = await res.json();
  if (!body.key) throw new Error(`no verification key for kid ${kid}`);

  // body.key is a JWK (kty/x/y/crv) for ES256. createPublicKey consumes it directly.
  const key = createPublicKey({ key: body.key, format: "jwk" });
  keyCache.set(kid, key);
  return key;
}

// Record the verified event to the platform's own store, and to a daily digest.
// This lane reads money; it never moves it, so nothing here acts on the event.
async function record(event) {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore(EVENT_STORE);
    const at = new Date().toISOString();
    const slug = `${at}-${event.webhook_code || "unknown"}`.replace(/[:.]/g, "-");

    await store.set(
      `events/${slug}.json`,
      JSON.stringify({ at, received: true, event }, null, 2)
    );

    const day = at.slice(0, 10);
    const line = `- ${at} | ${event.webhook_type}/${event.webhook_code} | item: ${event.item_id || "n/a"}\n`;
    let prev = "";
    try {
      const got = await store.get(`digest/${day}.md`);
      if (got) prev = typeof got === "string" ? got : await got.text();
    } catch { /* first write of the day */ }
    await store.set(`digest/${day}.md`, prev + line);

    return slug;
  } catch (e) {
    // A store failure must never turn a verified webhook into an error response.
    console.warn("event not recorded:", e && e.message);
    return null;
  }
}

export default async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return new Response("too large", { status: 413 });

  const token = req.headers.get("plaid-verification");
  if (!token) return new Response("no verification header", { status: 400 });

  const { header, payload, signingInput, signature } = decodeJwt(token);

  // 1. Freshness. Plaid's JWS carries iat; anything older than five minutes is refused.
  if (Math.abs(Date.now() - payload.iat * 1000) > MAX_IAT_SKEW_MS) {
    return new Response("stale webhook", { status: 400 });
  }

  // 2. Signature, against the key Plaid names in the kid claim.
  const key = await keyFor(header.kid);
  const ok = verify("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" }, signature);
  if (!ok) return new Response("bad signature", { status: 400 });

  // 3. Body hash. Proves the payload was not altered in transit.
  const bodyHash = createHash("sha256").update(raw).digest("hex");
  if (bodyHash !== payload.request_body_sha256) {
    return new Response("body hash mismatch", { status: 400 });
  }

  const event = JSON.parse(raw);
  const slug = await record(event);
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    verified: true,
    recorded: slug,
    type: event.webhook_type,
    code: event.webhook_code,
    item: event.item_id,
  }));

  return new Response("ok", { status: 200 });
};

/* ------------------------------------------------------------------
   The sandbox test, once deployed. Use a SANDBOX access token throughout.

   1. Make a sandbox item:  POST https://sandbox.plaid.com/sandbox/public_token/create
      { "client_id": ..., "secret": ..., "institution_id": "ins_109508",
        "initial_products": ["transactions"] }
      then POST /item/public_token/exchange with the returned public_token.

   2. Point the item here, no trailing slash:
      POST https://sandbox.plaid.com/item/webhook/update
      { ..., "access_token": "access-sandbox-...",
        "webhook": "https://queerpathways.info/.netlify/functions/plaid-webhook" }

   3. Fire it:
      POST https://sandbox.plaid.com/sandbox/item/fire_webhook
      { ..., "access_token": "access-sandbox-...",
        "webhook_type": "TRANSACTIONS", "webhook_code": "DEFAULT_UPDATE" }

      ITEM / NEW_ACCOUNTS_AVAILABLE returns SANDBOX_ACCOUNT_SELECT_V2_NOT_ENABLED on a default
      sandbox item: that webhook only exists on items made through Account Select v2.

   4. Confirm: a 200 in the function log, and a digest line under digest/<date>.md in the
      qp-plaid-events store.
   ------------------------------------------------------------------ */
