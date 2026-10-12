// POST /.netlify/functions/assistant  { message, history }  ->  { reply }
//
// PUBLIC — the website widget. NOT CLEARED FOR PUBLICATION.
// Kept present but inert: it refuses until ASSISTANT_ENABLED is set on the host.
// That way the route exists and can be tested, and it cannot answer a stranger by accident.
const { BRIEF, CONFIG } = require("./assistant-brief.js");

const MODEL = "claude-sonnet-4-5";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 20000;
const MAX_INPUT = 1200;
const MAX_TURNS = 12;

exports.handler = async (event) => {
  if (process.env.ASSISTANT_ENABLED !== "true") {
    return json(503, {
      error: "assistant_unavailable",
      message: "The assistant is not switched on.",
    });
  }
  const key = process.env.CLAUDE_API_KEY;
  if (!key) return json(503, { error: "assistant_unavailable", message: "The assistant is not configured." });
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad_json" }); }

  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_INPUT) : "";
  if (!message) return json(400, { error: "empty_message" });

  const history = Array.isArray(body.history) ? body.history.slice(-MAX_TURNS) : [];
  const messages = [
    ...history
      .filter((t) => t && typeof t.text === "string" && (t.role === "user" || t.role === "model"))
      .map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: String(t.text).slice(0, MAX_INPUT) })),
    { role: "user", content: message },
  ];

  const instruction = [
    BRIEF,
    "",
    "CONFIGURATION — the only figures you may state:",
    `Practice: ${CONFIG.practiceName}`,
    `Website: ${CONFIG.siteUrl}`,
    `Booking portal: ${CONFIG.bookingUrl}`,
    `Crisis line: ${CONFIG.crisisLine}`,
    `Rates: ${Object.keys(CONFIG.rates).length ? JSON.stringify(CONFIG.rates) : "not supplied — do not state any figure"}`,
    `Jurisdictions: ${CONFIG.jurisdictions.length ? CONFIG.jurisdictions.join(", ") : "not supplied — do not state any jurisdiction"}`,
    `Insurers: ${CONFIG.insurers.length ? CONFIG.insurers.join(", ") : "not supplied — do not name any insurer"}`,
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        system: instruction,
        messages,
        temperature: 0.4,
        max_tokens: 1024,
      }),
    });
    if (!r.ok) {
      console.error("assistant upstream", r.status, (await r.text()).slice(0, 500));
      return json(502, { error: "assistant_unavailable", message: "Something went wrong. Please try booking instead." });
    }
    const data = await r.json();
    const reply = (Array.isArray(data?.content) ? data.content : [])
      .filter((p) => p && p.type === "text")
      .map((p) => p.text || "")
      .join("")
      .trim();
    if (!reply) return json(502, { error: "empty_reply", message: "Something went wrong. Please try booking instead." });
    return json(200, { reply });
  } catch (err) {
    console.error("assistant failed", err && err.name === "AbortError" ? "timeout" : err);
    return json(504, { error: "assistant_unavailable", message: "Something went wrong. Please try booking instead." });
  } finally {
    clearTimeout(timer);
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  };
}
