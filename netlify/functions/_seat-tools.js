// What a seat is allowed to do when it is handed a folder.
//
// A seat's reply used to be text only, so it could never collect a source document, never
// write a document, and never file one. This module is the missing half: four callable
// Drive actions, the same four that finance-run exposes, plus Robert's repository actions.
//
// For Drive, the folder is bound by the operator, not by the model. The model is never given the folder
// id and cannot name one: every action here is scoped to the folder the request carried, and
// every target is checked against it before anything happens. So a seat cannot walk the
// estate even if it asks to.
//
// No delete, no share, no permission change, no folder creation. Absent on purpose.

const drive = require("./_drive");
const github = require("./_github");

const DECLARATIONS = [
  {
    name: "list_folder",
    description:
      "List the documents in the folder you were given. Call this first, to see what sources exist before you rely on any figure.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_document",
    description:
      "Read one document out of the folder you were given. Returns the text of a Google Doc, or the base64 of a PDF or spreadsheet.",
    parameters: {
      type: "object",
      properties: { file_id: { type: "string", description: "The id returned by list_folder." } },
      required: ["file_id"],
    },
  },
  {
    name: "create_document",
    description:
      "Create a document from text you supply directly in the folder you were given.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The document title." },
        text: { type: "string", description: "The body of the document, plainly written." },
      },
      required: ["title", "text"],
    },
  },
  {
    name: "file_document",
    description:
      "Place a document you created into the folder you were given, so the work is filed rather than left in chat.",
    parameters: {
      type: "object",
      properties: { file_id: { type: "string", description: "The id returned by create_document." } },
      required: ["file_id"],
    },
  },
];

// One call from the model, executed against one folder, and nothing else.
async function execute(folderId, name, args) {
  const a = args && typeof args === "object" ? args : {};
  if (!folderId) throw new Error("A Drive folder must be bound before using Drive actions.");

  if (name === "list_folder") {
    const files = await drive.listFolder(folderId);
    return { folder_id: folderId, count: files.length, files };
  }

  if (name === "read_document") {
    const fileId = String(a.file_id || "").trim();
    if (!fileId) return { error: "file_id is required." };
    // The boundary. A file outside the folder the operator named is not readable, full stop.
    if (!(await drive.isInside(fileId, folderId))) {
      return { error: "That document is not inside the folder you were given." };
    }
    const f = await drive.readFile(fileId);
    return f.encoding === "utf8"
      ? { id: f.id, name: f.name, mime_type: f.mimeType, text: f.text }
      : { id: f.id, name: f.name, mime_type: f.mimeType, base64: f.base64, note: "Binary. Not text, so do not infer figures from it." };
  }

  if (name === "create_document") {
    const title = String(a.title || "").trim();
    const text = String(a.text == null ? "" : a.text);
    if (!title) return { error: "title is required." };
    if (!text.trim()) return { error: "text is required. An empty document is not a deliverable." };
    const doc = await drive.createDoc(title, text, folderId);
    return { id: doc.id, url: doc.url, filed_in: folderId };
  }

  if (name === "file_document") {
    const fileId = String(a.file_id || "").trim();
    if (!fileId) return { error: "file_id is required." };
    const moved = await drive.fileInto(fileId, folderId);
    return { id: moved.id, url: moved.url, filed_in: folderId };
  }

  return { error: `There is no action called ${name}.` };
}

function declarations(seat, folderId) {
  return [
    ...(folderId ? DECLARATIONS : []),
    ...(seat?.id === "robert" ? github.DECLARATIONS : []),
  ];
}

async function executeForSeat(seat, folderId, name, args, signal) {
  if (!declarations(seat, folderId).some((tool) => tool.name === name)) {
    throw new Error(`The action ${name} is not available to this seat and run.`);
  }
  if (github.DECLARATIONS.some((tool) => tool.name === name)) {
    return github.execute(name, args, signal);
  }
  return execute(folderId, name, args);
}

module.exports = { DECLARATIONS, execute, declarations, executeForSeat };
