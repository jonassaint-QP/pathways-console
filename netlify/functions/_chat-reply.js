// The reply pipeline for a seat's turn: the model call, the action loop, the stream.
//
// Split out of chat.js so each file stays small enough to commit whole. A truncated commit
// of this file would silently remove half the pipeline, which is exactly what happened once.
//
// Drive is scoped to the operator-bound folder. GitHub is scoped to Robert's four repos.

const seatTools = require("./_seat-tools");

const MAX_TOOL_ROUNDS = 6;
const MODEL = "gemini-3.8-flash";

// What the seat is told when it has been handed a folder. It is told the actions exist and
// that the folder is fixed. It is not told the id, and it is told not to try to name one.
const FOLDER_NOTE = [
  "THE FOLDER YOU HAVE BEEN GIVEN.",
  "You have four actions: list_folder, read_document, create_document, file_document.",
  "The folder is fixed and you are already inside it. You are never given its id and you never",
  "need one; do not ask for one and do not try to name a different folder, because only this",
  "one is reachable.",
  "Work in this order: list the folder, read what you need, then write your document and file it",
  "there. A document left anywhere else is not filed. Do not deliver the work in chat instead of",
  "the folder.",
  "If the sources you need are not in the folder, say which are missing and stop. Do not estimate",
  "and do not construct figures by inference.",
].join("\n");

const GITHUB_NOTE = [
  "YOUR GITHUB ACTIONS.",
  "You can read files and directories, create working branches, commit file creates or updates,",
  "and open pull requests in jonassaint-QP/pathways-console, QP-Store, QP-Clinical and QueerPathways.",
  "Use github_get_file, github_create_branch, github_write_file and github_open_pull_request.",
  "Read the current file from the branch you will update and pass its SHA to avoid overwriting",
  "concurrent changes. Create a working branch before writing and open a pull request for review.",
  "These actions do not merge or deploy. Report the returned artifact and never claim it is live.",
  "GitHub actions do not need a Drive folder. If the token is missing or refused, say so and stop.",
].join("\n");

async function callModel(key, model, instruction, contents, folderId, controller, seat) {
  const payload = {
    systemInstruction: { parts: [{ text: instruction }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
  };
  const declarations = seatTools.declarations(seat, folderId);
  if (declarations.length) {
    payload.tools = [{ functionDeclarations: declarations }];
    payload.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(payload),
    }
  );
  if (!r.ok) return { ok: false, status: r.status, detail: (await r.text()).slice(0, 800) };
  return { ok: true, res: r };
}

async function* replyStream({ key, seat, contents, folderId, controller, timer, res, instruction, record }) {
  let reply = "";
  let recorded = null;
  const line = (value) => JSON.stringify(value) + "\n";
  const rounds = [];

  try {
    let roundsUsed = 0;

    while (true) {
      let finishReason = null;
      const calls = [];
      // The model's own parts, kept exactly as received. A Gemini 3 functionCall part carries a
      // thoughtSignature, and replaying the turn without it is refused. Rebuilding the part from
      // name and args would drop it, so the raw part is what goes back.
      const ownParts = [];

      for await (const data of modelEvents(res.body)) {
        if (data.error) throw new Error(data.error.message || "The model stream failed.");
        const candidate = data.candidates?.[0];
        for (const part of candidate?.content?.parts || []) {
          if (part.thought) continue; // private reasoning, never replayed and never shown
          if (typeof part.text === "string" && part.text) {
            reply += part.text;
            yield line({ type: "delta", text: part.text });
          }
          if (part.functionCall) calls.push(part.functionCall);
          ownParts.push(part);
        }
        if (candidate?.finishReason) finishReason = candidate.finishReason;
      }

      // No actions asked for, so this was the answer.
      if (!calls.length) {
        if (finishReason && finishReason !== "STOP") {
          throw new Error(finishReason === "MAX_TOKENS"
            ? "The answer reached the model's output limit. Try a narrower request."
            : "The model did not finish its answer.");
        }
        break;
      }

      if (roundsUsed >= MAX_TOOL_ROUNDS) {
        throw new Error("The action limit was reached before the run completed.");
      }
      roundsUsed++;

      contents.push({ role: "model", parts: ownParts });

      const resultParts = [];
      for (const call of calls) {
        let result;
        try {
          result = await seatTools.executeForSeat(seat, folderId, call.name, call.args, controller.signal);
        } catch (e) {
          console.error("seat action failed", call.name, e && e.message);
          result = { error: (e && e.message) || "the action failed." };
        }
        rounds.push({ name: call.name, args: call.args || {}, result });
        yield line({
          type: "tool",
          name: call.name,
          ok: !result.error,
          detail: result.error || result.name || result.id || (result.count != null ? `${result.count} items` : "ok"),
        });
        resultParts.push({ functionResponse: { name: call.name, response: { result } } });
      }
      contents.push({ role: "user", parts: resultParts });

      const next = await callModel(key, MODEL, instruction, contents, folderId, controller, seat);
      if (!next.ok) {
        throw new Error(`The model failed after an action (${next.status}): ${String(next.detail || "").slice(0, 300)}`);
      }
      res = next.res;
    }

    reply = reply.trim();
    if (!reply && rounds.length) {
      reply = rounds.some((round) => round.result.error)
        ? "The run ended with action errors. Review the action results."
        : "The actions completed. Review their returned artifacts.";
      yield line({ type: "delta", text: reply });
    }
    if (!reply) throw new Error("The model returned an empty answer.");
    clearTimeout(timer);

    try {
      const lastUser = [...contents].reverse().find((c) => c.role === "user" && c.parts[0].text);
      recorded = await record(seat, lastUser ? lastUser.parts[0].text : "", reply);
    } catch (e) {
      console.error("record write failed", e);
    }
    yield line({ type: "done", reply, recorded, actions: rounds.map((r) => r.name) });
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

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  };
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
        out.models_visible = parsed.models.map((m) => String(m.name || "").replace("models/", "")).slice(0, 40);
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

module.exports = { FOLDER_NOTE, GITHUB_NOTE, MODEL, callModel, replyStream, json, diag };
