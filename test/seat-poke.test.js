const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function load(overrides = {}) {
  const context = {
    module: { exports: {} }, require: overrides.require, console,
    process: { env: {} }, Intl, Date, AbortController, ...overrides,
  };
  context.exports = context.module.exports;
  vm.runInNewContext(fs.readFileSync(require.resolve("../netlify/functions/seat-poke.js"), "utf8"), context);
  return context.module.exports;
}

function loadSeatPoke(driveStub) {
  return load({
    require: (name) => {
      if (name === "./seats.json") return { adam: { id: "adam", name: "Adam" } };
      if (name === "./_drive.js") return driveStub;
      if (name === "./_chat-reply.js") return { MODEL: "test-model", FOLDER_NOTE: "", GITHUB_NOTE: "", callModel: async () => ({ status: 200 }) };
      return require(name);
    },
  });
}

test("appendSeatSignalLog creates a Heartbeat Register with the right argument order when none exists", async () => {
  const calls = { listFolder: [], createDoc: [], updateDoc: [], readFile: [] };
  const seatPoke = loadSeatPoke({
    listFolder: async (folderId) => { calls.listFolder.push(folderId); return []; },
    createDoc: async (title, text, folderId) => { calls.createDoc.push([title, text, folderId]); return { id: "new_doc", url: "https://example.test" }; },
    updateDoc: async (...args) => { calls.updateDoc.push(args); },
    readFile: async (...args) => { calls.readFile.push(args); return { encoding: "utf8", text: "" }; },
  });

  await seatPoke.appendSeatSignalLog("folder123", "Adam", "Checked, found nothing.");

  assert.deepEqual(calls.listFolder, ["folder123"]);
  assert.equal(calls.updateDoc.length, 0);
  assert.equal(calls.createDoc.length, 1);
  const [title, text, folderId] = calls.createDoc[0];
  assert.match(title, /Adam Heartbeat Register/);
  assert.match(text, /Checked, found nothing\./);
  assert.equal(folderId, "folder123");
});

test("appendSeatSignalLog appends to an existing register instead of creating a new one", async () => {
  const calls = { listFolder: [], createDoc: [], updateDoc: [], readFile: [] };
  const seatPoke = loadSeatPoke({
    listFolder: async (folderId) => {
      calls.listFolder.push(folderId);
      return [{ id: "existing_doc", name: "Adam Heartbeat Register", mimeType: "application/vnd.google-apps.document", isFolder: false }];
    },
    createDoc: async (...args) => { calls.createDoc.push(args); return { id: "new_doc" }; },
    updateDoc: async (...args) => { calls.updateDoc.push(args); },
    readFile: async (fileId) => { calls.readFile.push(fileId); return { encoding: "utf8", text: "# Adam Heartbeat Log\n- prior entry" }; },
  });

  await seatPoke.appendSeatSignalLog("folder123", "Adam", "Processed 2 pending items.");

  assert.equal(calls.createDoc.length, 0);
  assert.deepEqual(calls.readFile, ["existing_doc"]);
  assert.equal(calls.updateDoc.length, 1);
  const [fileId, text] = calls.updateDoc[0];
  assert.equal(fileId, "existing_doc");
  assert.match(text, /prior entry/);
  assert.match(text, /Processed 2 pending items\./);
});

test("a Drive failure is caught and logged rather than thrown", async () => {
  const seatPoke = loadSeatPoke({
    listFolder: async () => { throw new Error("Drive refused the call (500): boom"); },
  });
  // Must not throw: a logging failure should never take down the caller's run.
  await seatPoke.appendSeatSignalLog("folder123", "Adam", "Checked, found nothing.");
});
