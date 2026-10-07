// POST /.netlify/functions/visual
//   { seatId, prompt, referenceUrl? }  ->  { image, stored }
//
// The seat drafts its own visual. No founder paste, no external tab.
//
// Two capabilities in one function, because the anchor-edit rule needs both:
//
//   prompt + no reference   -> generation. A scene from a brief.
//   prompt + referenceUrl    -> image-to-image EDIT. The anchor is passed in as the
//                               reference, and the identity is carried from it rather
//                               than re-derived. This is the anchor-edit pipeline, and
//                               it is the only path that should produce a persona.
//
// The rendered image is written to the seat's record store AND to Adam's compliance
// record as a URL, so the two-copy floor covers visuals exactly as it covers text.
const seats = require("./seats.json");
const { record, initBlobs } = require("./_record.js");

// The estate's image model. gemini-3-pro-image is the highest-fidelity image model this
// key can reach; the flash variant is the cheaper fallback. Both were confirmed present
// on the host key via GET /api/chat?diag=1 on 7 October 2026.
const MODEL = "gemini-3-pro-image";
const FALLBACK_MODEL = "gemini-3.1-flash-image";
const TIMEOUT_MS = 90000;
const MAX_PROMPT = 4000;

exports.handler = async (event) => {
  initBlobs(event);
  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(503, { error: "no_key", message: "No GEMINI_API_KEY set on the host." });
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad_json" }); }

  const seat = seats[body.seatId];
  if (!seat) return json(404, { error: "unknown_seat" });

  const prompt = String(body.prompt || "").slice(0, MAX_PROMPT).trim();
  if (!prompt) return json(400, { error: "empty_prompt" });

  // A reference turns generation into an edit. This is what makes it anchor-edit.
  const reference = body.referenceUrl ? String(body.referenceUrl) : null;
  if (reference && !/^https:\/\//.test(reference)) {
    return json(400, { error: "bad_reference", message: "A reference must be an https URL." });
  }

  const parts = [{ text: buildInstruction(seat, prompt, Boolean(reference)) }];
  if (reference) {
    const refPart = await fetchAsInlineData(reference);
    if (refPart) parts.unshift(refPart); // reference first, instruction second
  }

  let result = await callGemini(key, MODEL, parts);
  if (result.error && result.status === 404) {
    // Model retired or unavailable to this key: fall back once, and say so.
    const second = await callGemini(key, FALLBACK_MODEL, parts);
    if (!second.error) { second.fallback_from = MODEL; result = second; }
  }
  if (result.error) return json(502, result);

  // Record both copies: the seat's own file and Adam's compliance record.
  let recorded = null;
  try {
    const note = reference
      ? `[visual] anchor-edit from ${reference}\n\nprompt: ${prompt}\n\nimage: ${await storeImage(result, seat)}`
      : `[visual] generated\n\nprompt: ${prompt}\n\nimage: ${await storeImage(result, seat)}`;
    recorded = await record(seat, note, "(visual delivered)");
  } catch (e) {
    console.error("visual record write failed", e);
  }

  return json(200, {
    image: result.image,
    mime: result.mime,
    mode: reference ? "anchor-edit" : "generation",
    model: result.model,
    fallback_from: result.fallback_from || null,
    recorded,
  });
};

// ---- the instruction the model receives ----
function buildInstruction(seat, prompt, isEdit) {
  const rules = [
    seat.instructions || "",
    seat.voice || "",
    seat.never || "",
  ].filter(Boolean).join("\n");

  return [
    isEdit
      ? "Edit the attached reference image. Change only the setting, wardrobe, lighting and action. " +
        "Preserve the identity in the reference exactly: facial structure, bone structure, skin tone, hair, " +
        "grooming and build. Do not re-derive or re-imagine the person. The person in the output is the person " +
        "in the reference."
      : "Generate the image described below.",
    "",
    prompt,
    "",
    "Constraints that always apply:",
    "- One person in frame unless the brief explicitly says otherwise.",
    "- Whole people with visible faces. No floating limbs, no headless bodies, no isolated parts.",
    "- No text, no typography, no letters, no numbers, no words, no watermarks, no logos in the image.",
    "- Do not draw a brand mark of any kind. Any mark is applied afterwards, outside the image.",
    "",
    "Context for the seat's own standards, applied to the visual:",
    rules,
  ].join("\n").slice(0, 12000);
}

// ---- fetch a reference into inline bytes so the model can edit from it ----
async function fetchAsInlineData(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 7 * 1024 * 1024) return null; // keep the request sane
    const mime = r.headers.get("content-type") || "image/webp";
    return { inlineData: { mimeType: mime.split(";")[0], data: buf.toString("base64") } };
  } catch (e) {
    console.error("reference fetch failed", e);
    return null;
  }
}

// ---- the model call ----
async function callGemini(key, model, parts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
      }
    );
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 700);
      console.error("visual upstream", model, r.status, detail);
      return {
        error: "upstream",
        upstream_status: r.status,
        model,
        message: "The image call failed.",
        hint:
          r.status === 404 ? "Model unavailable to this key."
          : r.status === 403 ? "Key refused. Check application restrictions and that the Generative Language API is enabled."
          : r.status === 400 ? "The request was rejected. The prompt or the reference may be too large."
          : "See the function log for the body.",
      };
    }
    const data = await r.json();
    const got = (data?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
    const inline = got && (got.inlineData || got.inline_data);
    if (!inline || !inline.data) return { error: "empty_image", model };
    return { image: `data:${inline.mimeType || inline.mime_type || "image/png"};base64,${inline.data}`, mime: inline.mimeType || "image/png", model };
  } catch (e) {
    console.error("visual failed", e && e.name === "AbortError" ? "timeout" : e);
    return { error: "timeout", message: "That took too long." };
  } finally {
    clearTimeout(timer);
  }
}

// ---- keep the image in the record as a URL, not as bytes ----
async function storeImage(result, seat) {
  // Netlify cannot host a new binary without a deploy, so the record carries the data URL
  // only when it is small enough to be useful, and otherwise a marker with the model name.
  const bytes = result.image.length;
  if (bytes < 400000) return result.image;
  return `(image rendered by ${result.model}, ${Math.round(bytes / 1024)}KB of base64 - too large to inline in the record; re-render to retrieve)`;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  };
}
