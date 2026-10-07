// POST /.netlify/functions/chat  { seatId, messages:[{role,text}] }  ->  { reply }
//
// PRIVATE. The console. One key, held in the host's environment variables, never in a file.
const seats = require("./seats.json");
const { record, initBlobs } = require("./_record.js");

const MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 45000;
const MAX_INPUT = 4000;
const MAX_TURNS = 24;

exports.handler = async (event) => {
  initBlobs(event);
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return json(503, { error: "no_key", message: "No GEMINI_API_KEY set on the host." });
  }
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad_json" }); }

  const seat = seats[body.seatId];
  if (!seat) return json(404, { error: "unknown_seat" });

  const history = Array.isArray(body.messages) ? body.messages.slice(-MAX_TURNS) : [];
  const contents = history
    .filter((m) => m && typeof m.text === "string" && (m.role === "user" || m.role === "model"))
    .map((m) => ({ role: m.role, parts: [{ text: String(m.text).slice(0, MAX_INPUT) }] }));

  if (!contents.length) return json(400, { error: "empty" });

  const instruction = [
    seat.instructions || "",
    "",
    seat.voice ? `VOICE.\n${seat.voice}` : "",
    seat.never ? `WHAT YOU NEVER DO.\n${seat.never}` : "",
  ].filter(Boolean).join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instruction }] },
          contents,
          generationConfig: { temperature: 0.6, maxOutputTokens: 4096 },
        }),
      }
    );
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 800);
      console.error("chat upstream", r.status, detail);
      // Name the status so a failure can be diagnosed without the host logs. The body is
      // not returned: it can echo the key back. 403 = key restricted or API disabled,
      // 400 = key invalid, 404 = model unavailable to this key.
      return json(502, {
        error: "upstream",
        upstream_status: r.status,
        message: "The model call failed.",
        hint:
          r.status === 403 ? "The key was refused. Check its application restrictions and that the Generative Language API is enabled."
          : r.status === 400 ? "The key was rejected as invalid."
          : r.status === 404 ? "The model is not available to this key."
          : "See the function log for the body.",
      });
    }
    const data = await r.json();
    const reply = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (!reply) return json(502, { error: "empty_reply" });

    // Two copies of every exchange: the seat's own record, and Adam's compliance record.
    // Written server-side so nothing has to be moved by hand. A write failure never blocks the reply.
    let recorded = null;
    try {
      const lastUser = [...contents].reverse().find((c) => c.role === "user");
      recorded = await record(seat, lastUser ? lastUser.parts[0].text : "", reply);
    } catch (e) {
      console.error("record write failed", e);
    }

    return json(200, { reply, recorded });
  } catch (err) {
    console.error("chat failed", err && err.name === "AbortError" ? "timeout" : err);
    return json(504, { error: "timeout", message: "That took too long." });
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
