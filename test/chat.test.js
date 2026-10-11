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
    process: { env: { GEMINI_API_KEY: "synthetic-test-key" } },
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

function sse(parts, finishReason = "STOP") {
  return parts.map((text) => "data: " + JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
  }) + "\r\n\r\n").join("") + "data: " + JSON.stringify({
    candidates: [{ finishReason }],
  }) + "\r\n\r\n";
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
  assert.match(chat.calls[0].url, /:streamGenerateContent\?alt=sse&key=/);
  assert.deepEqual(JSON.parse(chat.calls[0].init.body).generationConfig, {
    temperature: 0.7, maxOutputTokens: 8192,
  });
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
  for (const text of [sse(["Partial"], "MAX_TOKENS"), sse(["Partial"], "SAFETY"), "data: {bad}\n\n", 'data: {"candidates":[]}']) {
    const chat = loadChat({ upstream: response(text) });
    const result = await run(chat);
    const events = result.text.trim().split("\n").map(JSON.parse);
    assert.equal(events.at(-1).type, "error");
    assert.equal(chat.records.length, 0);
    assert.ok(chat.logs.length);
  }
});

test("Robert gets GitHub tools without a folder and tool rounds preserve thought signatures", async () => {
  const toolPart = {
    functionCall: { name: "github_get_file", args: { repo: "QP-Store", path: "package.json" } },
    thoughtSignature: "synthetic-signature",
  };
  const first = "data: " + JSON.stringify({
    candidates: [{ content: { parts: [toolPart] }, finishReason: "STOP" }],
  }) + "\n\n";
  const executed = [];
  const chat = loadChat({
    upstream: [response(first), response(sse(["Read the file."]))],
    execute: async (...args) => { executed.push(args); return { content: "{}" }; },
  });
  const result = await run(chat, { seatId: "robert" });
  assert.match(result.text, /"type":"tool","name":"github_get_file","ok":true/);
  const payloads = chat.calls.map((call) => JSON.parse(call.init.body));
  for (const payload of payloads) {
    assert.deepEqual(payload.tools[0].functionDeclarations.map((tool) => tool.name),
      ["github_get_file", "github_create_branch", "github_write_file", "github_open_pull_request"]);
  }
  assert.deepEqual(payloads[1].contents[1].parts[0], toolPart);
  assert.equal(executed[0][0].id, "robert");
  assert.equal(executed[0][1], "");
});

test("folder tools and GitHub tools are composed only for the appropriate seat", async () => {
  for (const [seatId, folderId, count] of [
    ["jason", "", 0], ["jason", "folder123", 4],
    ["robert", "", 4], ["robert", "folder123", 8],
  ]) {
    const chat = loadChat({ upstream: response(sse(["Hello"])) });
    await run(chat, { seatId, folderId });
    const payload = JSON.parse(chat.calls[0].init.body);
    assert.equal(payload.tools?.[0].functionDeclarations.length || 0, count);
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
  const text = 'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Private reasoning"},{"text":"Answer"}]},"finishReason":"STOP"}]}\n\n';
  const chat = loadChat({ upstream: response(text) });
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
