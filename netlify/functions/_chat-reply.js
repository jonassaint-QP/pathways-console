// The reply pipeline for a seat's turn: the model call, the action loop, the stream.
//
// Split out of chat.js so each file stays small enough to commit whole. A truncated commit
// of this file would silently remove half the pipeline, which is exactly what happened once.
//
// Drive is scoped to the operator-bound folder. GitHub is scoped to Robert's repositories.
//
// Runs on Anthropic's Claude API. Extended thinking stays on with a small budget: Claude
// requires a thinking block (with its signature) to be replayed verbatim in every later turn
// exactly as received - the same constraint Gemini's thoughtSignature carried before this seat
// moved providers. See the content-block handling in replyStream.

const seatTools = require("./_seat-tools");

const MAX_TOOL_ROUNDS = 20;
const MODEL = "claude-haiku-4-5";
const ANTHROPIC_VERSION = "2023-06-01";

// Anthropic requires budget_tokens >= 1024 and strictly less than max_tokens. A small, fixed
// budget keeps the console's whole point - speed - while still giving a seat a little room to
// reason about which action to take next, rather than committing to its first guess.
const THINKING_BUDGET = 1024;
const MAX_OUTPUT_TOKENS = 8192;
const WRAP_UP_MAX_OUTPUT_TOKENS = 2048; // must stay above THINKING_BUDGET, thinking stays on

// How much time is reserved, before the hard deadline, to stop searching and ask the model to
// summarize whatever it has found so far. Without this, a search that runs out the clock is
// discarded whole and the operator is left with nothing — see WRAP_UP_NOTE below.
const WRAP_UP_MARGIN_MS = 6000;

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
  "and open pull requests in jonassaint-QP/pathways-console, QP-Store, QP-Clinical, QueerPathways,",
  "QP-Backroom-v2 and QP-Backroom-Retired.",
  "Use github_get_file, github_create_branch, github_write_file and github_open_pull_request.",
  "Read the current file from the branch you will update and pass its SHA to avoid overwriting",
  "concurrent changes. Create a working branch before writing and open a pull request for review.",
  "These actions do not merge or deploy. Report the returned artifact and never claim it is live.",
  "GitHub actions do not need a Drive folder. If the token is missing or refused, say so and stop.",
].join("\n");

// Told only on the one round where time is nearly out. No further actions are offered to the
// model on this call (see callModel's noTools option), so it cannot ask for one anyway.
const WRAP_UP_NOTE = [
  "YOU ARE NEARLY OUT OF TIME.",
  "Do not request any further actions; none are available on this turn. Answer now, in plain",
  "text, from what you have already found. If the task is incomplete, say plainly what you found",
  "and what is still open, so the operator can ask you to continue.",
].join("\n");

async function callModel(key, model, instruction, messages, folderId, controller, seat, options = {}) {
  const payload = {
    model,
    system: instruction,
    messages,
    max_tokens: options.wrapUp ? WRAP_UP_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
    // Extended thinking forces temperature to the API default; the two cannot be set together.
    thinking: { type: "enabled", budget_tokens: THINKING_BUDGET },
    stream: true,
  };
  if (!options.noTools) {
    const declarations = seatTools.declarations(seat, folderId);
    if (declarations.length) {
      payload.tools = declarations.map((d) => ({
        name: d.name,
        description: d.description,
        input_schema: d.parameters,
      }));
    }
  }

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    signal: controller.signal,
    body: JSON.stringify(payload),
  });
  if (!r.ok) return { ok: false, status: r.status, detail: (await r.text()).slice(0, 800) };
  return { ok: true, res: r };
}

async function* replyStream({ key, seat, contents, folderId, controller, timer, deadline, res, instruction, record }) {
  let reply = "";
  let recorded = null;
  let wrappedUp = false;
  const line = (value) => JSON.stringify(value) + "\n";
  const rounds = [];

  try {
    let roundsUsed = 0;

    while (true) {
      let stopReason = null;
      // The assistant's own content blocks for this turn, finalized in arrival order, kept
      // exactly as received. A thinking block carries a signature, and replaying the turn
      // without it - or with it altered - is refused. Rebuilding a block from scratch would
      // drop or corrupt that signature, so the raw block is what goes back.
      const blocks = [];
      const partial = {};

      for await (const evt of modelEvents(res.body)) {
        if (evt.type === "error") throw new Error((evt.error && evt.error.message) || "The model stream failed.");

        if (evt.type === "content_block_start") {
          const b = evt.content_block || {};
          if (b.type === "text") partial[evt.index] = { type: "text", text: b.text || "" };
          else if (b.type === "thinking") partial[evt.index] = { type: "thinking", thinking: b.thinking || "", signature: "" };
          else if (b.type === "tool_use") partial[evt.index] = { type: "tool_use", id: b.id, name: b.name, inputJson: "" };
        } else if (evt.type === "content_block_delta") {
          const p = partial[evt.index];
          if (!p) continue;
          const d = evt.delta || {};
          if (d.type === "text_delta" && typeof d.text === "string") {
            p.text += d.text;
            reply += d.text;
            yield line({ type: "delta", text: d.text });
          } else if (d.type === "thinking_delta") {
            p.thinking += d.thinking || ""; // private reasoning, never shown
          } else if (d.type === "signature_delta") {
            p.signature += d.signature || "";
          } else if (d.type === "input_json_delta") {
            p.inputJson += d.partial_json || "";
          }
        } else if (evt.type === "content_block_stop") {
          const p = partial[evt.index];
          if (p) {
            if (p.type === "tool_use") {
              let input = {};
              try { input = p.inputJson ? JSON.parse(p.inputJson) : {}; } catch { /* the call below reports the empty args */ }
              blocks[evt.index] = { type: "tool_use", id: p.id, name: p.name, input };
            } else if (p.type === "thinking") {
              blocks[evt.index] = { type: "thinking", thinking: p.thinking, signature: p.signature };
            } else {
              blocks[evt.index] = { type: "text", text: p.text };
            }
          }
        } else if (evt.type === "message_delta") {
          if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
        }
        // message_start, message_stop, ping: nothing to collect.
      }

      const ownBlocks = blocks.filter(Boolean);
      const calls = ownBlocks.filter((b) => b.type === "tool_use");

      // No actions asked for, so this was the answer.
      if (!calls.length) {
        if (stopReason && stopReason !== "end_turn" && stopReason !== "stop_sequence") {
          throw new Error(stopReason === "max_tokens"
            ? "The answer reached the model's output limit. Try a narrower request."
            : "The model did not finish its answer.");
        }
        break;
      }

      if (roundsUsed >= MAX_TOOL_ROUNDS) {
        throw new Error("The action limit was reached before the run completed.");
      }
      roundsUsed++;

      contents.push({ role: "assistant", content: ownBlocks });

      const resultBlocks = [];
      for (const call of calls) {
        let result;
        try {
          result = await seatTools.executeForSeat(seat, folderId, call.name, call.input, controller.signal);
        } catch (e) {
          console.error("seat action failed", call.name, e && e.message);
          result = { error: (e && e.message) || "the action failed." };
        }
        rounds.push({ name: call.name, args: call.input || {}, result });
        yield line({
          type: "tool",
          name: call.name,
          ok: !result.error,
          detail: result.error || result.name || result.id || (result.count != null ? `${result.count} items` : "ok"),
        });
        resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: [{ type: "text", text: JSON.stringify(result) }] });
      }
      contents.push({ role: "user", content: resultBlocks });

      // Running low on the deadline? Spend what is left on one wrap-up call instead of another
      // search round: no tools offered, so the model must answer now from what it already has.
      const closeToDeadline = !wrappedUp && deadline && (deadline - Date.now()) <= WRAP_UP_MARGIN_MS;
      if (closeToDeadline) {
        wrappedUp = true;
        yield line({ type: "tool", name: "wrap_up", ok: true, detail: "Running low on time — summarizing findings so far." });
      }
      const roundInstruction = closeToDeadline ? `${instruction}\n\n${WRAP_UP_NOTE}` : instruction;

      const next = await callModel(
        key, MODEL, roundInstruction, contents, folderId, controller, seat,
        closeToDeadline ? { noTools: true, wrapUp: true } : {}
      );
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
      const lastUser = [...contents].reverse().find(
        (c) => c.role === "user" && Array.isArray(c.content) && c.content.some((b) => b.type === "text")
      );
      const lastUserText = lastUser ? lastUser.content.find((b) => b.type === "text").text : "";
      recorded = await record(seat, lastUserText, reply);
    } catch (e) {
      console.error("record write failed", e);
    }
    yield line({ type: "done", reply, recorded, actions: rounds.map((r) => r.name) });
  } catch (err) {
    console.error("chat stream failed", err);
    yield line({
      type: "error",
      message: err.name === "AbortError" ? "Hey, it's taking a little longer. Give me a few minutes." : err.message,
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Anthropic's SSE carries an `event:` line before each `data:` line, but the JSON payload's own
// `type` field already names the event, so the event: line itself doesn't need to be tracked.
async function* modelEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (!line.startsWith("data:")) continue; // blank lines and event: lines carry no data
      const dataStr = line.slice(5).replace(/^ /, "");
      let data;
      try { data = JSON.parse(dataStr); } catch { continue; }
      yield data;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw new Error("The model stream ended mid-event.");
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  };
}

// Ask Anthropic, with the host's own key, what this key is allowed to reach.
async function diag(key, model) {
  const scrub = (t) => String(t || "").split(key).join("<key>").slice(0, 900);
  const out = { key_present: true, key_length: key.length, key_tail: key.slice(-4) };
  const headers = { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };

  try {
    const list = await fetch("https://api.anthropic.com/v1/models", { headers });
    out.list_status = list.status;
    const listText = await list.text();
    out.list_body = scrub(listText);
    try {
      const parsed = JSON.parse(listText);
      if (Array.isArray(parsed.data)) {
        out.models_visible = parsed.data.map((m) => m.id).slice(0, 40);
      }
    } catch { /* the raw body above is the finding */ }
  } catch (e) {
    out.list_error = scrub(e && e.message);
  }

  try {
    const one = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: "say ok" }] }),
    });
    out.model_status = one.status;
    out.model_body = scrub(await one.text());
    out.model_tried = model;
  } catch (e) {
    out.model_error = scrub(e && e.message);
  }

  return json(200, out);
}

module.exports = { FOLDER_NOTE, GITHUB_NOTE, MODEL, callModel, replyStream, json, diag };
