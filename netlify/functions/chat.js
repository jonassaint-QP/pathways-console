// POST /.netlify/functions/chat { seatId, messages:[{role,text}], folderId? } -> NDJSON stream
//
// PRIVATE. The console. One key, held in the host's environment variables, never in a file.
//
// folderId is optional and operator-supplied. When it is present the seat is given the four
// folder actions as tools, so it can list what it was handed, read a source, write a document
// and file it. The model is never told the id and cannot name one.
// Robert also receives four repository actions, regardless of whether a folder is bound.

const seats = require("./seats.json");
const { record, initBlobs } = require("./_record.js");
const { guard } = require("./_auth.js");
const reply = require("./_chat-reply.js");
const { stream } = require("@netlify/functions");
const { Readable } = require("node:stream");

// Netlify's Pro plan hard-kills a function at 26 seconds of execution, streaming or not, with
// zero signal to the client when it happens mid-stream. TIMEOUT_MS must stay safely under that
// ceiling so the app's own abort always fires first and can flush a proper "error" event before
// the platform silently cuts the connection. Lower this if the site ever drops back to a plan
// with a shorter execution limit (see README).
const TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS) || 22000;
const MAX_INPUT = 4000;
const MAX_TURNS = 24;

// Claude rejects any request whose messages do not strictly alternate user/assistant/user/...,
// starting with user - unlike Gemini, which tolerated consecutive same-role turns. A client
// thread can end up with consecutive user turns after a failed reply (the browser only ever
// appends a *successful* assistant turn to its history), so this merges those back into a
// single turn rather than trusting the client to never produce that shape.
function alternateRoles(messages) {
  const merged = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = last.content.concat(m.content);
    else merged.push({ role: m.role, content: m.content.slice() });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  return merged;
}

exports.handler = stream(async (event, context) => {
  const denied = guard(event);
  if (denied) return denied;

  context.callbackWaitsForEmptyEventLoop = false;
  initBlobs(event);
  const key = process.env.CLAUDE_API_KEY;
  if (!key) {
    return reply.json(503, { error: "no_key", message: "No CLAUDE_API_KEY set on the host." });
  }

  // GET /api/chat?diag=1 -> what this key can actually reach. The key is scrubbed from the reply.
  const q = event.queryStringParameters || {};
  if (q.diag) {
    return await reply.diag(key, q.model && /^[a-z0-9.\-]+$/i.test(q.model) ? q.model : reply.MODEL);
  }

  if (event.httpMethod !== "POST") return reply.json(405, { error: "method_not_allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return reply.json(400, { error: "bad_json" }); }

  const seat = seats[body.seatId];
  if (!seat) return reply.json(404, { error: "unknown_seat" });

  // The one folder this request may touch. Shaped like a Drive id or the request stops here.
  const folderId = String(body.folderId || "").trim();
  if (folderId && !/^[A-Za-z0-9_-]{3,200}$/.test(folderId)) {
    return reply.json(400, { error: "bad_folder", message: "That is not a Drive folder id." });
  }

  const history = Array.isArray(body.messages) ? body.messages.slice(-MAX_TURNS) : [];
  const contents = alternateRoles(history
    .filter((m) => m && typeof m.text === "string" && (m.role === "user" || m.role === "model"))
    .map((m) => ({
      role: m.role === "model" ? "assistant" : "user",
      content: [{ type: "text", text: String(m.text).slice(0, MAX_INPUT) }],
    })));

  if (!contents.length) return reply.json(400, { error: "empty" });

  const instruction = [
    seat.instructions || "",
    "",
    seat.voice ? `VOICE.\n${seat.voice}` : "",
    seat.never ? `WHAT YOU NEVER DO.\n${seat.never}` : "",
    folderId ? reply.FOLDER_NOTE : "",
    seat.id === "robert" ? reply.GITHUB_NOTE : "",
  ].filter(Boolean).join("\n");

  const controller = new AbortController();
  const deadline = Date.now() + TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const first = await reply.callModel(key, reply.MODEL, instruction, contents, folderId, controller, seat);
    if (!first.ok) {
      clearTimeout(timer);
      console.error("chat upstream", first.status, first.detail);
      // Anthropic's error body is JSON ({error:{type,message}}); pull the message out so the
      // operator sees the real reason directly in the chat bubble, with no log access needed.
      let upstreamDetail = first.detail;
      try {
        const parsed = JSON.parse(first.detail);
        if (parsed && parsed.error) upstreamDetail = `${parsed.error.type || "error"}: ${parsed.error.message || ""}`.trim();
      } catch { /* not JSON; the raw text is still useful as-is */ }
      return reply.json(502, {
        error: "upstream",
        upstream_status: first.status,
        message: "The model call failed.",
        detail: upstreamDetail,
        hint:
          first.status === 401 ? "The key was rejected as invalid."
          : first.status === 403 ? "The key was refused. Check that it is permitted to reach the model."
          : first.status === 404 ? "The model is not available to this key."
          : first.status === 429 ? "Rate limited. Slow down the request rate or raise the plan's limit."
          : "See the function log for the body.",
      });
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
      body: Readable.from(reply.replyStream({
        key, seat, contents, folderId, controller, timer, deadline, res: first.res, instruction, record,
      })),
    };
  } catch (err) {
    clearTimeout(timer);
    const timedOut = err && err.name === "AbortError";
    console.error("chat failed", timedOut ? "timeout" : err);
    return reply.json(timedOut ? 504 : 502, {
      error: timedOut ? "timeout" : "upstream",
      message: timedOut ? "Hey, it's taking a little longer. Give me a few minutes." : "Could not read the model response.",
    });
  }
});
