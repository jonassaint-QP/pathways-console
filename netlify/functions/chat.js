// POST /.netlify/functions/chat { seatId, messages:[{role,text}] } -> NDJSON stream
//
// PRIVATE. The console. One key, held in the host's environment variables, never in a file.
const seats = require("./seats.json");
const { record, initBlobs } = require("./_record.js");
const { guard } = require("./_auth.js");
const { stream } = require("@netlify/functions");
const { Readable } = require("node:stream");

// gemini-2.5-flash and 2.5-pro are no longer available to new users: Google returns
// 404 "This model models/gemini-2.5-flash is no longer available to new users."
const MODEL = "gemini-3.8-flash";
const TIMEOUT_MS = 45000;
const MAX_INPUT = 4000;
const MAX_TURNS = 24;

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
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instruction }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
        }),
      }
    );
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 800);
      clearTimeout(timer);
      console.error("chat upstream", r.status, detail);
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
    if (!r.body) throw new Error("The model returned no response body.");
    return {
      statusCode: 200,
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
      body: Readable.from(replyStream(r.body, seat, contents, controller, timer)),
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

async function* replyStream(body, seat, contents, controller, timer) {
  let reply = "";
  let finishReason = null;
  const line = (value) => JSON.stringify(value) + "\n";
  try {
    for await (const data of modelEvents(body)) {
      if (data.error) throw new Error(data.error.message || "The model stream failed.");
      const candidate = data.candidates?.[0];
      const text = (candidate?.content?.parts || [])
        .filter((p) => !p.thought && typeof p.text === "string")
        .map((p) => p.text).join("");
      if (text) {
        reply += text;
        yield line({ type: "delta", text });
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
    }
    if (finishReason !== "STOP") {
      throw new Error(finishReason === "MAX_TOKENS"
        ? "The answer reached the model's output limit. Try a narrower request."
        : "The model did not finish its answer.");
    }
    reply = reply.trim();
    if (!reply) throw new Error("The model returned an empty answer.");
    clearTimeout(timer);

    // Finish both records before emitting the completion event.
    let recorded = null;
    try {
      const lastUser = [...contents].reverse().find((c) => c.role === "user");
      recorded = await record(seat, lastUser ? lastUser.parts[0].text : "", reply);
    } catch (e) {
      console.error("record write failed", e);
    }
    yield line({ type: "done", reply, recorded });
  } catch (err) {
    console.error("chat stream failed", err);
    yield line({
      type: "error",
      message: err.name === "AbortError" ? "That took too long. The answer is incomplete." : err.message,
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function* modelEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (!line) {
        if (dataLines.length) {
          yield JSON.parse(dataLines.join("\n"));
          dataLines = [];
        }
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() || dataLines.length) throw new Error("The model stream ended mid-event.");
}

// Ask Google, with the host's own key, what this key is allowed to reach.
async function diag(key, model) {
  const scrub = (t) => String(t || "").split(key).join("<key>").slice(0, 900);
  const out = { key_present: true, key_length: key.length, key_tail: key.slice(-4) };

  try {
    const list = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    out.list_status = list.status;
    const listText = await list.text();
    out.list_body = scrub(listText);
    try {
      const parsed = JSON.parse(listText);
      if (Array.isArray(parsed.models)) {
        out.models_visible = parsed.models
          .map((m) => String(m.name || "").replace("models/", ""))
          .slice(0, 40);
      }
    } catch { /* the raw body above is the finding */ }
  } catch (e) {
    out.list_error = scrub(e && e.message);
  }

  try {
    const one = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "say ok" }] }] }),
      }
    );
    out.model_status = one.status;
    out.model_body = scrub(await one.text());
    out.model_tried = model;
  } catch (e) {
    out.model_error = scrub(e && e.message);
  }

  return json(200, out);
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  };
}
