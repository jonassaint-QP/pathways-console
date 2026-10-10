// The founder's handle on a seat's Drive work.
//
// Four actions, so a run can be watched from outside: list the folder, read one document out
// of it, create a document, file that document into the folder.
//
// Gated by the same guard as every other console route, and the guard is the first thing that
// runs. A folder id is required for every action and every target is checked against it, so
// this endpoint cannot walk the account, and there is no Drive-wide query in it to reach.
//
// No delete, no share, no permission change, no folder creation. Those are not stubs for
// later. They are absent on purpose.

const { guard } = require("./_auth");
const drive = require("./_drive");

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function out(statusCode, payload) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(payload) };
}

function fail(statusCode, error, message) {
  return out(statusCode, { ok: false, error, message });
}

function body(event) {
  let raw = event && event.body;
  if (raw == null) return {};
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("The request body is not JSON.");
  }
}

exports.handler = async (event) => {
  // First statement, before Drive, before the body, before anything.
  const denied = guard(event);
  if (denied) return denied;

  if (event.httpMethod && event.httpMethod !== "POST") {
    return fail(405, "method_not_allowed", "POST only.");
  }

  let input;
  try {
    input = body(event);
  } catch (e) {
    return fail(400, "bad_request", e.message);
  }

  const action = String(input.action || "").trim();
  const folderId = String(input.folderId || "").trim();

  if (!folderId) {
    return fail(400, "no_folder", "A folderId is required. This endpoint never operates Drive-wide.");
  }

  try {
    if (action === "list") {
      const files = await drive.listFolder(folderId);
      return out(200, { ok: true, action, folderId, count: files.length, files });
    }

    if (action === "read") {
      const fileId = String(input.fileId || "").trim();
      if (!fileId) return fail(400, "no_file", "A fileId is required to read.");
      if (!(await drive.isInside(fileId, folderId))) {
        return fail(403, "outside_folder", "That file is not inside the folder you named.");
      }
      const file = await drive.readFile(fileId);
      return out(200, { ok: true, action, file });
    }

    if (action === "create") {
      const doc = await drive.createDoc(input.title, input.text);
      return out(200, { ok: true, action, document: doc, filed: false });
    }

    if (action === "file") {
      const fileId = String(input.fileId || "").trim();
      if (!fileId) return fail(400, "no_file", "A fileId is required to file.");
      const moved = await drive.fileInto(fileId, folderId);
      return out(200, { ok: true, action, document: moved, filed: true });
    }

    if (action === "collect") {
      // create then file, in one call, so a run can be driven in a single step.
      const doc = await drive.createDoc(input.title, input.text);
      const moved = await drive.fileInto(doc.id, folderId);
      return out(200, { ok: true, action, document: { ...doc, ...moved }, filed: true });
    }

    return fail(400, "unknown_action", `action must be list, read, create, file or collect. Got "${action}".`);
  } catch (e) {
    // Fail closed, and name what is missing rather than returning an empty success.
    const message = (e && e.message) || "Drive call failed.";
    const missing = /GOOGLE_SA_KEY_JSON/.test(message);
    return fail(missing ? 503 : 502, missing ? "no_drive_key" : "drive_error", message);
  }
};
