// POST /.netlify/functions/chat { seatId, messages:[{role,text}], folderId? } -> NDJSON stream
//
// PRIVATE. The console. One key, held in the host's environment variables, never in a file.
//
// folderId is optional and operator-supplied. When it is present the seat is given the four
// folder actions as tools, so it can list what it was handed, read a source, write a document
// and file it. The model is never told the id and cannot name one: the folder is bound here,
// for the life of the request, and the tools refuse anything outside it.
const seats = require("./seats.json");
const { record, initBlobs } = require("./_record.js");
const { guard } = require("./_auth.js");
const seatTools = require("./_seat-tools.js");
const { stream } = require("@netlify/functions");
const { Readable } = require("node:stream");

// gemini-2.5-flash and 2.5-pro are no longer available to new users: Google returns
// 404 "This model models/gemini-2.5-flash is no longer available to new users."
const MODEL = "gemini-3.8-flash";
const TIMEOUT_MS = 45000;
const MAX_INPUT = 4000;
const MAX_TURNS = 24;
const MAX_TOOL_ROUNDS = 6;

exports.handler = stream(async (event, context) => {
  const denied = guard(event);
  if (denied) return denied;

  // The streaming wrapper awaits the body pipeline; unrelated open sockets need not delay it.
  context.callbackWaitsForEmptyEventLoop = false;
  initBlobs(event);
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return json(503, { error: "no_key", message: "No GEMINI_API_KEY set on the host." });
  }

  // One diagnostic, so a failing key can be named without reading host logs.
  // GET /api/chat?diag=1 -> what this key can actually reach. The key is scrubbed from the reply.
  const q = event.queryStringParameters || {};
  if (q.diag) {
    return await diag(key, q.model && /^[a-z0-9.\-]+$/i.test(q.model) ? q.model : MODEL);
  }

  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad_json" }); }

  const seat = seats[body.seatId];
  if (!seat) return json(404, { error: "unknown_seat" });

  // The one folder this request may touch. Shaped like a Drive id or the request stops here.
  const folderId = String(body.folderId || "").trim();
  if (folderId && !/^[A-Za-z0-9_-]{3,200}$/.test(folderId)) {
    return json(400, { error: "bad_folder", message: "That is not a Drive folder id." });
  }

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
    folderId ? FOLDER_NOTE : "",
  ].filter(Boolean).join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const first = await callModel(key, MODEL, instruction, contents, folderId, controller);
    if (!first.ok) {
      const detail = first.detail;
      clearTimeout(timer);
      console.error("chat upstream", first.status, detail);
      return json(502, {
        error: "upstream",
        upstream_status: first.status,
        message: "The model call failed.",
        hint:
          first.status === 403 ? "The key was refused. Check its application restrictions and that the Generative Language API is enabled."
          : first.status === 400 ? "The key was rejected as invalid."
          : first.status === 404 ? "The model is not available to this key."
          : "See the function log for the body.",
      });
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
      body: Readable.from(
        replyStream({ key, seat, contents, folderId, controller, timer, res: first.res, instruction })
      ),
    };
  } catch (err) {
    clearTimeout(timer);
    const timedOut = err && err.name === "AbortError";
    console.error("chat failed", timedOut ? "timeout" : err);
    return json(timedOut ? 504 : 502, {
      error: timedOut ? "timeout" : "upstream",
      message: timedOut ? "That took too long." : "Could not read the model response.",
    });
  }
});
