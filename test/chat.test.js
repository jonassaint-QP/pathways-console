const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { PassThrough } = require("node:stream");
const { readChatStream } = require("../public/chat-stream.js");

global.awslambda = {
  streamifyResponse: (handler) => handler,
  HttpResponseStream: { from: (stream, metadata) => { stream.metadata = metadata; return stream; } },
};
const { stream } = require("@netlify/functions");
const source = fs.readFileSync(require.resolve("../netlify/functions/chat.js"), "utf8");

function loadChat(options = {}) {
  const calls = [], records = [], logs = [];
  const context = {
    exports: {},
    require: (name) => {
      if (name === "@netlify/functions") return { stream };
      if (name === "./seats.json") return {
        jason: { id: "jason", instructions: "Be helpful." },
        robert: { id: "robert", instructions: "Build." },
      };
      if (name === "./_chat-reply.js") return pipeline;
      if (name === "./_auth.js") return { guard: () => options.denied || null };
      if (name === "./_record.js") return {
        initBlobs: () => {},
        record: async (...args) => {
          records.push(args);
          if (options.record) return options.record();
          return { seatKey: "seat.md", adamKey: "adam.md" };
        },
      };
      return require(name);
    },
    process: { env: { CLAUDE_API_KEY: "synthetic-test-key", ...(options.env || {}) } },
    console: { error: (...args) => logs.push(args) },
    AbortController, TextDecoder, setTimeout, clearTimeout,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (options.fetchError) throw options.fetchError;
      if (Array.isArray(options.upstream)) return options.upstream[calls.length - 1];
      return options.upstream;
    },
  };
  const tools = require("../netlify/functions/_seat-tools");
  const pipelineContext = {
    ...context, module: { exports: {} },
    require: (name) => name === "./_seat-tools" ? {
      declarations: tools.declarations,
      executeForSeat: async (...args) => {
        if (options.execute) return options.execute(...args);
        throw new Error("Unexpected action.");
      },
    } : require(name),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../netlify/functions/_chat-reply.js"), "utf8"), pipelineContext);
  const pipeline = pipelineContext.module.exports;
  vm.runInNewContext(source, context);
  return { handler: context.exports.handler, calls, records, logs };
}

function sseEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// A minimal, valid Claude stream for a plain multi-chunk text answer.
function sse(textParts, stopReason = "end_turn") {
  let out = sseEvent("message_start", { type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } });
  out += sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const text of textParts) {
    out += sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  }
  out += sseEvent("content_block_stop", { type: "content_block_stop", index: 0 });
  out += sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: {} });
  out += sseEvent("message_stop", { type: "message_stop" });
  return out;
}

// A stream where the assistant requests exactly one tool call, optionally preceded by a
// thinking block, to exercise the signature-preservation requirement.
function toolUseSSE(name, input, { thinking } = {}) {
  let out = sseEvent("message_start", { type: "message_start", message: { id: "msg_2", role: "assistant", content: [] } });
  let index = 0;
  if (thinking) {
    out += sseEvent("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
    out += sseEvent("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: thinking.text } });
    out += sseEvent("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: thinking.signature } });
    out += sseEvent("content_block_stop", { type: "content_block_stop", index });
    index++;
  }
  out += sseEvent("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: "toolu_1", name } });
  out += sseEvent("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
  out += sseEvent("content_block_stop", { type: "content_block_stop", index });
  out += sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} });
  out += sseEvent("message_stop", { type: "message_stop" });
  return out;
}

function response(text, size = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  }));
}

async function run(chat, body = {}) {
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  const context = {};
  await chat.handler({
    httpMethod: "POST",
    body: JSON.stringify({ seatId: "jason", messages: [{ role: "user", text: "Hello" }], ...body }),
  }, output, context);
  return { text: Buffer.concat(chunks).toString(), metadata: output.metadata, context };
}

test("streams split UTF-8 events, records the whole answer and completes the pipeline", async () => {
  const chat = loadChat({ upstream: response(sse(["Hello ", "🌈 world"])) });
  const output = await run(chat);
  const events = output.text.trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((e) => e.type), ["delta", "delta", "done"]);
  assert.equal(events[2].reply, "Hello 🌈 world");
  assert.equal(chat.records[0][2], events[2].reply);
  assert.equal(output.context.callbackWaitsForEmptyEventLoop, false);
  assert.match(chat.calls[0].url, /api\.anthropic\.com\/v1\/messages/);
  const payload = JSON.parse(chat.calls[0].init.body);
  assert.equal(payload.max_tokens, 8192);
  assert.deepEqual(payload.thinking, { type: "enabled", budget_tokens: 1024 });
  assert.equal(payload.temperature, undefined); // forced to the API default whenever thinking is on
  assert.equal(payload.stream, true);
  const clientResponse = response(output.text);
  clientResponse.headers.set("content-type", "application/x-ndjson");
  const seen = [];
  const done = await readChatStream(clientResponse, (text) => seen.push(text));
  assert.deepEqual(seen, ["Hello ", "Hello 🌈 world"]);
  assert.equal(done.reply, events[2].reply);
});

test("completion waits for record writes, rather than ending at handler return", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const chat = loadChat({ upstream: response(sse(["Hi"])), record: () => gate });
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const invocation = chat.handler({
    httpMethod: "POST", body: JSON.stringify({ seatId: "jason", messages: [{ role: "user", text: "Hello" }] }),
  }, output, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text, /"type":"delta"/);
  assert.doesNotMatch(text, /"type":"done"/);
  assert.equal(output.writableEnded, false);
  release({ seatKey: "seat.md", adamKey: "adam.md" });
  await invocation;
  assert.match(text, /"type":"done"/);
  assert.equal(output.writableEnded, true);
});

test("auth denial and upstream failure remain JSON HTTP errors", async () => {
  const denied = loadChat({ denied: { statusCode: 401, body: '{"error":"unauthorized"}' } });
  assert.equal((await run(denied)).metadata.statusCode, 401);
  assert.equal(denied.calls.length, 0);
  const failed = loadChat({ upstream: new Response("upstream failure", { status: 403 }) });
  const result = await run(failed);
  assert.equal(result.metadata.statusCode, 502);
  assert.equal(JSON.parse(result.text).upstream_status, 403);
});

test("incomplete, malformed and output-limited model streams never record or complete", async () => {
  const emptyStream = sseEvent("message_start", { type: "message_start", message: {} }) + sseEvent("message_stop", { type: "message_stop" });
  const errorEvent = sseEvent("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  for (const text of [sse(["Partial"], "max_tokens"), sse(["Partial"], "refusal"), errorEvent, emptyStream]) {
    const chat = loadChat({ upstream: response(text) });
    const result = await run(chat);
    const events = result.text.trim().split("\n").map(JSON.parse);
    assert.equal(events.at(-1).type, "error");
    assert.equal(chat.records.length, 0);
    assert.ok(chat.logs.length);
  }
});

test("Robert gets GitHub tools without a folder and tool rounds preserve thinking blocks", async () => {
  const thinking = { text: "Let me check the file.", signature: "synthetic-signature" };
  const first = toolUseSSE("github_get_file", { repo: "QP-Store", path: "package.json" }, { thinking });
  const executed = [];
  const chat = loadChat({
    upstream: [response(first), response(sse(["Read the file."]))],
    execute: async (...args) => { executed.push(args); return { content: "{}" }; },
  });
  const result = await run(chat, { seatId: "robert" });
  assert.match(result.text, /"type":"tool","name":"github_get_file","ok":true/);
  const payloads = chat.calls.map((call) => JSON.parse(call.init.body));
  for (const payload of payloads) {
    assert.deepEqual(payload.tools.map((tool) => tool.name),
      [
        "github_get_file", "github_create_branch", "github_write_file", "github_open_pull_request",
        "github_list_pull_requests", "github_list_commits", "github_get_tree", "probe_url",
      ]);
  }
  // The assistant turn pushed back into history must carry the thinking block exactly as
  // received, signature included - Claude refuses a tool-result turn otherwise.
  assert.deepEqual(payloads[1].messages[1].content[0], { type: "thinking", thinking: thinking.text, signature: thinking.signature });
  assert.equal(payloads[1].messages[1].content[1].type, "tool_use");
  assert.equal(executed[0][0].id, "robert");
  assert.equal(executed[0][1], "");
});

test("a run close to the deadline wraps up with a summary instead of hard-aborting", async () => {
  const first = toolUseSSE("list_folder", {});
  // CHAT_TIMEOUT_MS=1 means the deadline has already effectively passed by the time the
  // first tool round finishes executing, forcing the wrap-up branch deterministically.
  const chat = loadChat({
    env: { CHAT_TIMEOUT_MS: "1" },
    upstream: [response(first), response(sse(["Here is what I found so far."]))],
    execute: async () => ({ count: 3, files: [] }),
  });
  const result = await run(chat, { seatId: "jason", folderId: "folder123" });
  const events = result.text.trim().split("\n").map(JSON.parse);

  assert.ok(events.some((e) => e.type === "tool" && e.name === "list_folder"));
  assert.ok(events.some((e) => e.type === "tool" && e.name === "wrap_up"));
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.reply, "Here is what I found so far.");

  // The wrap-up call must offer no further actions and must carry the wrap-up note, so the
  // model cannot keep searching and is pushed to answer from what it already has.
  const wrapUpPayload = JSON.parse(chat.calls[1].init.body);
  assert.equal(wrapUpPayload.tools, undefined);
  assert.equal(wrapUpPayload.max_tokens, 2048);
  assert.deepEqual(wrapUpPayload.thinking, { type: "enabled", budget_tokens: 1024 });
  assert.match(wrapUpPayload.system, /YOU ARE NEARLY OUT OF TIME/);
});

test("folder tools and GitHub tools are composed only for the appropriate seat", async () => {
  for (const [seatId, folderId, count] of [
    ["jason", "", 0], ["jason", "folder123", 4],
    ["robert", "", 8], ["robert", "folder123", 12],
  ]) {
    const chat = loadChat({ upstream: response(sse(["Hello"])) });
    await run(chat, { seatId, folderId });
    const payload = JSON.parse(chat.calls[0].init.body);
    assert.equal(payload.tools?.length || 0, count);
  }
});

test("record failure is logged and reported without losing a completed answer", async () => {
  const chat = loadChat({
    upstream: response(sse(["Hi"])),
    record: () => { throw new Error("Storage unavailable"); },
  });
  const result = await run(chat);
  const done = JSON.parse(result.text.trim().split("\n").at(-1));
  assert.equal(done.reply, "Hi");
  assert.equal(done.recorded, null);
  assert.ok(chat.logs.length);
});

test("upstream timeout and network errors are distinguished", async () => {
  for (const [error, status, code] of [
    [new DOMException("Aborted", "AbortError"), 504, "timeout"],
    [new TypeError("Network unavailable"), 502, "upstream"],
  ]) {
    const result = await run(loadChat({ fetchError: error }));
    assert.equal(result.metadata.statusCode, status);
    assert.equal(JSON.parse(result.text).error, code);
  }
});

test("private model thoughts are not included in replies or records", async () => {
  let out = sseEvent("message_start", { type: "message_start", message: {} });
  out += sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  out += sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Private reasoning" } });
  out += sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
  out += sseEvent("content_block_stop", { type: "content_block_stop", index: 0 });
  out += sseEvent("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  out += sseEvent("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } });
  out += sseEvent("content_block_stop", { type: "content_block_stop", index: 1 });
  out += sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} });
  out += sseEvent("message_stop", { type: "message_stop" });
  const chat = loadChat({ upstream: response(out) });
  const result = await run(chat);
  assert.doesNotMatch(result.text, /Private reasoning/);
  assert.equal(chat.records[0][2], "Answer");
});

test("client rejects missing final chunks, mismatched completion and stream errors", async () => {
  for (const text of [
    '{"type":"delta","text":"Partial"}\n',
    '{"type":"done","reply":"missing"}\n',
    '{"type":"error","message":"Timed out"}\n',
    '{"type":"delta","text":"Hi"}\n{"type":"done","reply":"Hi"}',
    '{"type":"delta","text":"Hi"}\n{"type":"done","reply":"Hi"}\n{"type":"delta","text":"extra"}\n',
  ]) {
    const r = response(text);
    r.headers.set("content-type", "application/x-ndjson");
    await assert.rejects(readChatStream(r, () => {}));
  }
});
