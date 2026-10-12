// What a seat is allowed to do when it is handed a folder.
//
// Drives actions available to all seats: listing folders and subfolders, reading files,
// creating documents in any descendant folder, filing/moving items within the folder boundary,
// creating folders, renaming items, and updating document content.
//
// Bound to the root folder passed into the session. Every target folder or file is verified
// with drive.isInside against the session's bound root folder, preventing any operation
// from escaping the designated estate boundary.
//
// No delete, no trash, no share, no permission change.

const drive = require("./_drive");
const github = require("./_github");
const netlify = require("./_netlify");

const DECLARATIONS = [
  {
    name: "list_folder",
    description:
      "List the documents and subfolders in the root folder or a specific subfolder. Call this first to inspect folder hierarchy and contents.",
    parameters: {
      type: "object",
      properties: {
        folder_id: {
          type: "string",
          description: "Optional folder ID to list. Defaults to the session's assigned root folder.",
        },
      },
      required: [],
    },
  },
  {
    name: "read_document",
    description:
      "Read one document out of the folder hierarchy. Returns the text of a Google Doc, or the base64 of a PDF or spreadsheet.",
    parameters: {
      type: "object",
      properties: { file_id: { type: "string", description: "The file ID to read." } },
      required: ["file_id"],
    },
  },
  {
    name: "create_document",
    description:
      "Create a document from text you supply. Can be placed into the root folder or any designated subfolder inside it.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The document title." },
        text: { type: "string", description: "The body of the document, plainly written." },
        folder_id: {
          type: "string",
          description: "Optional target folder ID. Defaults to the session's assigned root folder.",
        },
      },
      required: ["title", "text"],
    },
  },
  {
    name: "create_folder",
    description:
      "Create a new directory subfolder within the root folder or inside an existing subfolder.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the new folder." },
        parent_folder_id: {
          type: "string",
          description: "Optional parent folder ID. Defaults to the session's assigned root folder.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "file_document",
    description:
      "Move or file an existing document or subfolder into a target folder within the boundary.",
    parameters: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The ID of the file or folder to move." },
        target_folder_id: {
          type: "string",
          description: "Optional target folder ID. Defaults to the session's assigned root folder.",
        },
      },
      required: ["file_id"],
    },
  },
  {
    name: "rename_file",
    description:
      "Rename an existing document, spreadsheet, or folder inside the hierarchy.",
    parameters: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The ID of the file or folder to rename." },
        new_name: { type: "string", description: "The new name for the file or folder." },
      },
      required: ["file_id", "new_name"],
    },
  },
  {
    name: "update_document",
    description:
      "Update or overwrite the text body of an existing Google Document.",
    parameters: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The Google Doc ID to update." },
        text: { type: "string", description: "The new text body of the document." },
      },
      required: ["file_id", "text"],
    },
  },
];

// One call from the model, executed against one folder hierarchy, and nothing else.
async function execute(folderId, name, args) {
  const a = args && typeof args === "object" ? args : {};
  if (!folderId) throw new Error("A Drive folder must be bound before using Drive actions.");

  if (name === "list_folder") {
    const targetFolder = String(a.folder_id || "").trim() || folderId;
    if (!(await drive.isInside(targetFolder, folderId))) {
      return { error: "That folder is not inside the folder hierarchy you were given." };
    }
    const files = await drive.listFolder(targetFolder);
    return { folder_id: targetFolder, count: files.length, files };
  }

  if (name === "read_document") {
    const fileId = String(a.file_id || "").trim();
    if (!fileId) return { error: "file_id is required." };
    if (!(await drive.isInside(fileId, folderId))) {
      return { error: "That document is not inside the folder hierarchy you were given." };
    }
    const f = await drive.readFile(fileId);
    return f.encoding === "utf8"
      ? { id: f.id, name: f.name, mime_type: f.mimeType, text: f.text }
      : { id: f.id, name: f.name, mime_type: f.mimeType, base64: f.base64, note: "Binary. Not text, so do not infer figures from it." };
  }

  if (name === "create_document") {
    const title = String(a.title || "").trim();
    const text = String(a.text == null ? "" : a.text);
    const targetFolder = String(a.folder_id || "").trim() || folderId;
    if (!title) return { error: "title is required." };
    if (!text.trim()) return { error: "text is required. An empty document is not a deliverable." };
    if (!(await drive.isInside(targetFolder, folderId))) {
      return { error: "Target folder is not inside the folder hierarchy you were given." };
    }
    const doc = await drive.createDoc(title, text, targetFolder);
    return { id: doc.id, url: doc.url, filed_in: targetFolder };
  }

  if (name === "create_folder") {
    const folderName = String(a.name || "").trim();
    const parentFolder = String(a.parent_folder_id || "").trim() || folderId;
    if (!folderName) return { error: "name is required." };
    if (!(await drive.isInside(parentFolder, folderId))) {
      return { error: "Parent folder is not inside the folder hierarchy you were given." };
    }
    const folder = await drive.createFolder(folderName, parentFolder);
    return { id: folder.id, name: folder.name, url: folder.url, parent_id: parentFolder };
  }

  if (name === "file_document") {
    const fileId = String(a.file_id || "").trim();
    const targetFolder = String(a.target_folder_id || "").trim() || folderId;
    if (!fileId) return { error: "file_id is required." };
    if (!(await drive.isInside(fileId, folderId))) {
      return { error: "The file you are trying to move is not inside your folder hierarchy." };
    }
    if (!(await drive.isInside(targetFolder, folderId))) {
      return { error: "The target destination folder is not inside your folder hierarchy." };
    }
    const moved = await drive.fileInto(fileId, targetFolder);
    return { id: moved.id, url: moved.url, filed_in: targetFolder };
  }

  if (name === "rename_file") {
    const fileId = String(a.file_id || "").trim();
    const newName = String(a.new_name || "").trim();
    if (!fileId) return { error: "file_id is required." };
    if (!newName) return { error: "new_name is required." };
    if (!(await drive.isInside(fileId, folderId))) {
      return { error: "That item is not inside the folder hierarchy you were given." };
    }
    const renamed = await drive.renameFile(fileId, newName);
    return { id: renamed.id, name: renamed.name, url: renamed.url };
  }

  if (name === "update_document") {
    const fileId = String(a.file_id || "").trim();
    const text = String(a.text == null ? "" : a.text);
    if (!fileId) return { error: "file_id is required." };
    if (!text.trim()) return { error: "text is required." };
    if (!(await drive.isInside(fileId, folderId))) {
      return { error: "That document is not inside the folder hierarchy you were given." };
    }
    const updated = await drive.updateDoc(fileId, text);
    return { id: updated.id, name: updated.name, url: updated.url };
  }

  return { error: `There is no action called ${name}.` };
}

function declarations(seat, folderId) {
  return [
    ...(folderId ? DECLARATIONS : []),
    ...(seat?.id === "robert" ? [...github.DECLARATIONS, ...netlify.DECLARATIONS] : []),
  ];
}

async function executeForSeat(seat, folderId, name, args, signal) {
  if (!declarations(seat, folderId).some((tool) => tool.name === name)) {
    throw new Error(`The action ${name} is not available to this seat and run.`);
  }
  if (github.DECLARATIONS.some((tool) => tool.name === name)) {
    return github.execute(name, args, signal);
  }
  if (netlify.DECLARATIONS.some((tool) => tool.name === name)) {
    return netlify.execute(name, args, signal);
  }
  return execute(folderId, name, args);
}

module.exports = { DECLARATIONS, execute, declarations, executeForSeat };
