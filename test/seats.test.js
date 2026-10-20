const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("seat configuration is valid JSON with all seven runtime seat entries", () => {
  const seats = JSON.parse(fs.readFileSync(require.resolve("../netlify/functions/seats.json"), "utf8"));
  const ids = ["jason", "adam", "mark", "david", "ethan", "robert", "michael"];

  assert.deepEqual(Object.keys(seats).sort(), ids.slice().sort());
  for (const id of ids) {
    assert.equal(seats[id].id, id);
    for (const field of ["name", "title", "instructions"]) {
      assert.equal(typeof seats[id][field], "string", `${id}.${field} must be a string`);
      assert.ok(seats[id][field].trim(), `${id}.${field} must not be empty`);
    }
  }
});
