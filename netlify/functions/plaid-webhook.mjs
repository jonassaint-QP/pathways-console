// Plaid webhook receiver — Queer Pathways
// Verifies the JWT Plaid sends in the Plaid-Verification header, then records the event.
// Netlify Functions v2. Save at netlify/functions/plaid-webhook.mjs
//
// Netlify env vars required:
//   PLAID_CLIENT_ID  — not secret
//   PLAID_SECRET     — secret (sandbox value while testing)
//   PLAID_HOST       — optional. Defaults to sandbox. Set to production.plaid.com only when live.

import { verify, createHash } from "node:crypto";

const MAX_BODY_BYTES = 200 * 1024;
const MAX_IAT_SKEW_MS = 5 * 60 * 1000;

// Sandbox credentials are rejected by the production host, so this must follow the environment.
const PLAID_HOST = process.env.PLAID_HOST || "sandbox.plaid.com";

function b64urlToBuffer(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeJwt(token) {
  const [h, p, sig] = token.split(".");
  return {
    header: JSON.parse(b64urlToBuffer(h).toString("utf8")),
    payload: JSON.parse(b64urlToBuffer(p).toString("utf8")),
    signingInput: `${h}.${p}`,
    signature: b64urlToBuffer(sig),
  };
}

// Plaid returns the verification key as a raw base64 DER blob. crypto.verify needs a PEM,
// so it has to be wrapped in BEGIN/END lines before use. Fetched per kid, cached in memory.
const keyCache = new Map();
async function pemFor(kid) {
  if (keyCache.has(kid)) return keyCache.get(kid);

  const res = await fetch(`https://${PLAID_HOST}/webhook_verification_key/get`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      key_id: kid,
    }),
  });

  const body = await res.json();
  if (!body.key) throw new Error(`no verification key for kid ${kid}: ${JSON.stringify(body)}`);

  const pem = `-----BEGIN PUBLIC KEY-----\n${body.key}\n-----END PUBLIC KEY-----`;
  keyCache.set(kid, pem);
  return pem;
}

export default async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return new Response("too large", { status: 413 });

  const token = req.headers.get("plaid-verification");
  if (!token) return new Response("no verification header", { status: 400 });

  const { header, payload, signingInput, signature } = decodeJwt(token);

  // 1. Freshness. Reject anything older than five minutes.
  if (Math.abs(Date.now() - payload.iat * 1000) > MAX_IAT_SKEW_MS) {
    return new Response("stale webhook", { status: 400 });
  }

  // 2. Signature, against the key Plaid names in the kid claim.
  const pem = await pemFor(header.kid);
  const ok = verify("sha256", Buffer.from(signingInput), pem, signature);
  if (!ok) return new Response("bad signature", { status: 400 });

  // 3. Body hash. Proves the payload was not altered in transit.
  const bodyHash = createHash("sha256").update(raw).digest("hex");
  if (bodyHash !== payload.request_body_sha256) {
    return new Response("body hash mismatch", { status: 400 });
  }

  // Verified. Record the event. Never act on it here: this lane reads money, it never moves it.
  const event = JSON.parse(raw);
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    type: event.webhook_type,
    code: event.webhook_code,
    item: event.item_id,
  }));

  return new Response("ok", { status: 200 });
};

/* ------------------------------------------------------------------
   The sandbox test, once deployed.
   Replace <site> and use a SANDBOX access token throughout.

   1. Make a sandbox item:
      POST https://sandbox.plaid.com/sandbox/public_token/create
      { "client_id": ..., "secret": ..., "institution_id": "ins_109508",
        "initial_products": ["transactions"] }
      then POST /item/public_token/exchange with that public_token.

   2. Point the item at this endpoint (no trailing slash):
      POST https://sandbox.plaid.com/item/webhook/update
      { "client_id": ..., "secret": ..., "access_token": "access-sandbox-...",
        "webhook": "https://<site>/.netlify/functions/plaid-webhook" }

   3. Fire the webhook you asked for:
      POST https://sandbox.plaid.com/sandbox/item/fire_webhook
      { "client_id": ..., "secret": ..., "access_token": "access-sandbox-...",
        "webhook_type": "ITEM", "webhook_code": "NEW_ACCOUNTS_AVAILABLE" }

   4. Confirm in the Netlify function log: the event JSON, then a 200.
      If it returns 401, the CONSOLE_KEY route gate is still catching this path.
   ------------------------------------------------------------------ */
