// Google Drive access for the seats, delegated to the estate's Workspace user.
//
// The seats can talk but cannot reach a folder. This module is the read and write path they
// use: list a folder, read a document, create a document, file it, create folders, move, rename,
// and update documents.
//
// Auth is a service-account JWT assertion exchanged for an access token, cached in module
// scope until it is within a minute of expiry. No googleapis, no build step, plain fetch.
//
// The key lives in GOOGLE_SA_KEY_JSON on the host and nowhere else. Never logged, never
// echoed in an error, never returned. Accepts the raw JSON or the same JSON base64-encoded.
//
// Scope is bounded to the root folder passed into the session: actions refuse every operation
// outside that root and verify target folders/files are strictly within that hierarchy.

const crypto = require("crypto");

const SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const SLIDES = "application/vnd.google-apps.presentation";
const FOLDER = "application/vnd.google-apps.folder";

const MAX_WALK = 10; // ancestors examined when checking a file against a folder

let cached = null;

function serviceAccount() {
  const raw = process.env.GOOGLE_SA_KEY_JSON;
  if (!raw) {
    throw new Error(
      "GOOGLE_SA_KEY_JSON is not set on the host, so no seat can reach Drive. " +
      "Add the service-account JSON under Environment variables, marked Secret, then clear-cache deploy."
    );
  }
  let text = String(raw).trim();
  if (!text.startsWith("{")) {
    try { text = Buffer.from(text, "base64").toString("utf8"); } catch (e) { /* the parse below reports it */ }
  }
  let key;
  try {
    key = JSON.parse(text);
  } catch (e) {
    throw new Error("GOOGLE_SA_KEY_JSON is neither JSON nor base64-encoded JSON.");
  }
  if (!key.client_email || !key.private_key) {
    throw new Error("GOOGLE_SA_KEY_JSON is missing client_email or private_key.");
  }
  return key;
}

// An id goes into a Drive query string, so only ids shaped like ids are allowed through.
function id(value, what) {
  const v = String(value == null ? "" : value).trim();
  if (!/^[A-Za-z0-9_-]{3,200}$/.test(v)) {
    throw new Error(`A ${what} id is required and it is not a Drive id.`);
  }
  return v;
}

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function accessToken(signal) {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - 60 > now) return cached.token;

  const key = serviceAccount();
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email,
    sub: "jonassaint@queerpathways.org",
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const assertion = `${signingInput}.${b64url(signer.sign(key.private_key))}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    signal,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google refused the service-account token (${res.status}): ${body.error || "no detail"}`);
  }

  cached = { token: body.access_token, expiresAt: now + (body.expires_in || 3600) };
  return cached.token;
}

async function call(url, init, signal) {
  const token = await accessToken(signal);
  const res = await fetch(url, {
    ...(init || {}),
    signal,
    headers: { ...((init && init.headers) || {}), authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const e = body && body.error;
    const msg = (e && (e.message || e)) || body || res.status;
    throw new Error(`Drive refused the call (${res.status}): ${typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 300)}`);
  }
  return body;
}

async function meta(fileId, signal) {
  return call(`${API}/files/${id(fileId, "file")}?fields=id,name,mimeType,modifiedTime,parents,webViewLink&supportsAllDrives=true`, undefined, signal);
}

// Everything directly inside one folder. Nothing else is reachable through this call.
async function listFolder(folderId, signal) {
  const f = id(folderId, "folder");
  const q = encodeURIComponent(`'${f}' in parents and trashed = false`);
  const body = await call(
    `${API}/files?q=${q}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=200&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    undefined,
    signal
  );
  return (body.files || []).map((x) => ({
    id: x.id,
    name: x.name,
    mimeType: x.mimeType,
    modifiedTime: x.modifiedTime || null,
    size: x.size ? Number(x.size) : null,
    isFolder: x.mimeType === FOLDER,
  }));
}

// A Google Doc comes back as text. A PDF or a Word file comes back as base64, with its type,
// for the caller to hand on. Nothing is written to disk and nothing is logged.
async function readFile(fileId, signal) {
  const info = await meta(fileId, signal);
  const googleNative = [DOC, SHEET, SLIDES].includes(info.mimeType);

  if (googleNative) {
    const exportAs = info.mimeType === SHEET ? "text/csv" : "text/plain";
    const token = await accessToken(signal);
    const res = await fetch(`${API}/files/${info.id}/export?mimeType=${encodeURIComponent(exportAs)}`, {
      signal,
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Drive refused to export the document (${res.status}).`);
    return { id: info.id, name: info.name, mimeType: info.mimeType, text: await res.text(), encoding: "utf8" };
  }

  const token = await accessToken(signal);
  const res = await fetch(`${API}/files/${info.id}?alt=media&supportsAllDrives=true`, {
    signal,
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive refused to read the file (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { id: info.id, name: info.name, mimeType: info.mimeType, base64: buf.toString("base64"), encoding: "base64" };
}

// Create inside the target folder, never in the service account's root.
async function createDoc(title, text, folderId = process.env.GOOGLE_DRIVE_FOLDER_ID, signal) {
  const name = String(title == null ? "" : title).trim();
  if (!name) throw new Error("A title is required to create a document.");
  const parent = id(folderId, "folder");

  const created = await call(`${API}/files?fields=id,webViewLink&supportsAllDrives=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: DOC, parents: [parent] }),
  }, signal);

  await call(`${UPLOAD}/files/${created.id}?uploadType=media&supportsAllDrives=true`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: String(text == null ? "" : text),
  }, signal);

  return { id: created.id, url: created.webViewLink || `https://docs.google.com/document/d/${created.id}/edit` };
}

// Create a directory folder inside the target folder.
async function createFolder(name, parentFolderId, signal) {
  const folderName = String(name == null ? "" : name).trim();
  if (!folderName) throw new Error("A folder name is required.");
  const parent = id(parentFolderId, "folder");

  const created = await call(`${API}/files?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: folderName, mimeType: FOLDER, parents: [parent] }),
  }, signal);

  return { id: created.id, name: created.name, url: created.webViewLink || null };
}

// Update the text content of an existing Google Document.
async function updateDoc(fileId, text, signal) {
  const f = id(fileId, "file");
  await call(`${UPLOAD}/files/${f}?uploadType=media&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: String(text == null ? "" : text),
  }, signal);
  const updated = await meta(f, signal);
  return { id: updated.id, name: updated.name, url: updated.webViewLink || `https://docs.google.com/document/d/${f}/edit` };
}

// Rename an existing file or folder.
async function renameFile(fileId, newName, signal) {
  const f = id(fileId, "file");
  const name = String(newName == null ? "" : newName).trim();
  if (!name) throw new Error("A new name is required.");

  const renamed = await call(`${API}/files/${f}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }, signal);

  return { id: renamed.id, name: renamed.name, url: renamed.webViewLink || null };
}

// Is this file or folder equal to, or descendant of, the root folder? Fails closed.
async function isInside(fileId, folderId, signal) {
  const want = id(folderId, "folder");
  let current = id(fileId, "file");
  if (current === want) return true;

  for (let step = 0; step < MAX_WALK; step++) {
    const info = await meta(current, signal);
    const parents = info.parents || [];
    if (parents.includes(want)) return true;
    if (!parents.length) return false;
    current = parents[0];
  }
  return false;
}

// Put the file in the folder, and take it out of wherever it was.
async function fileInto(fileId, folderId, signal) {
  const f = id(fileId, "file");
  const into = id(folderId, "folder");
  const info = await meta(f, signal);
  const from = (info.parents || []).filter((p) => p !== into);

  const params = new URLSearchParams({ addParents: into, fields: "id,parents,webViewLink", supportsAllDrives: "true" });
  if (from.length) params.set("removeParents", from.join(","));

  const moved = await call(`${API}/files/${f}?${params.toString()}`, { method: "PATCH" }, signal);
  return { id: moved.id, parents: moved.parents || [], url: moved.webViewLink || null };
}

module.exports = {
  listFolder,
  readFile,
  createDoc,
  createFolder,
  updateDoc,
  renameFile,
  fileInto,
  isInside,
  meta,
  DOC,
  FOLDER,
};
