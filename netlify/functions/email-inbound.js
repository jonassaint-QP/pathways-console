// POST /.netlify/functions/email-inbound
//
// Inbound email handler for Jason.
// Catches forwarded/routed messages sent to Joshua Jonassaint, files the inbound signal
// into Jason's seat folder in Google Drive, and calls Jason's AI model session to draft
// a response or execute immediate triage.
//
// Authenticated via INBOUND_EMAIL_SECRET bearer token or query parameter.

const seats = require("./seats.json");
const drive = require("./_drive.js");
const reply = require("./_chat-reply.js");

const JASON_INBOX_FOLDER_ID = "1bap6uw8l0E7Nb_ldYp87AI1Cmg-6I22V"; // 03 Seat Folders > Jason > 04 Inbox
const JASON_SIGNAL_REG_ID = "163TdO6aOv1fl977gjPlZPm0gm3bwheMs2Km30NwkDlU"; // Jason 3, Signal Register

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "method_not_allowed" }),
    };
  }

  // Security verification
  const secret = process.env.INBOUND_EMAIL_SECRET;
  if (secret) {
    const authHeader = (event.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const querySecret = (event.queryStringParameters || {}).secret;
    if (authHeader !== secret && querySecret !== secret) {
      return {
        statusCode: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "unauthorized" }),
      };
    }
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "bad_json" }),
    };
  }

  const from = payload.from || payload.sender || "Unknown Sender";
  const to = payload.to || payload.recipient || "jonassaint@queerpathways.org";
  const subject = payload.subject || "No Subject";
  const bodyText = payload.text || payload.body || payload.html || "(No message body)";
  const receivedAt = new Date().toISOString();

  const formattedTimestamp = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());

  const signalTitle = `INBOUND EMAIL — ${subject.slice(0, 50)} — ${Date.now()}`;
  const signalContent = [
    `# INBOUND EMAIL SIGNAL`,
    ``,
    `- **Received:** ${formattedTimestamp} (ET)`,
    `- **From:** ${from}`,
    `- **To:** ${to}`,
    `- **Subject:** ${subject}`,
    ``,
    `## Message Body`,
    `\`\`\``,
    bodyText,
    `\`\`\``,
  ].join("\n");

  let createdFile = null;
  try {
    // File document directly into Jason's 04 Inbox subfolder
    createdFile = await drive.createDoc(signalTitle, signalContent, JASON_INBOX_FOLDER_ID);
  } catch (driveErr) {
    console.error("Failed to write email doc to Drive:", driveErr);
  }

  // Append entry to Jason's Signal Register
  try {
    const currentReg = await drive.readFile(JASON_SIGNAL_REG_ID);
    const updatedRegText = (currentReg.text || "") +
      `\n\n- **[${formattedTimestamp} ET] Inbound Email Received:** "${subject}" from \`${from}\`. Filed: ${createdFile ? createdFile.url : "Drive write failed"}.`;
    await drive.updateDoc(JASON_SIGNAL_REG_ID, updatedRegText);
  } catch (regErr) {
    console.error("Failed to update Jason signal register:", regErr);
  }

  // Wake Jason up immediately to process the email
  const geminiKey = process.env.GEMINI_API_KEY;
  let jasonResponse = null;

  if (geminiKey && seats.jason) {
    try {
      const jasonSeat = seats.jason;
      const instruction = [
        jasonSeat.instructions || "",
        "",
        jasonSeat.voice ? `VOICE.\n${jasonSeat.voice}` : "",
        jasonSeat.never ? `WHAT YOU NEVER DO.\n${jasonSeat.never}` : "",
        reply.FOLDER_NOTE,
      ].filter(Boolean).join("\n");

      const promptText = [
        `URGENT INBOUND EMAIL RECEIVED FOR JOSHUA JONASSAINT.`,
        `From: ${from}`,
        `Subject: ${subject}`,
        `Timestamp: ${formattedTimestamp}`,
        ``,
        `Body:`,
        bodyText,
        ``,
        `Review this email. If a response draft or immediate operational action is required, take action now:`,
        `1. Create any necessary draft or routing slip in your folder.`,
        `2. Note in your Signal Register the action taken.`,
        `3. Provide a summary of your action.`,
      ].join("\n");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);

      const contents = [{ role: "user", parts: [{ text: promptText }] }];
      const modelResult = await reply.callModel(
        geminiKey,
        reply.MODEL,
        instruction,
        contents,
        JASON_INBOX_FOLDER_ID,
        controller,
        jasonSeat
      );

      clearTimeout(timer);

      if (modelResult.ok) {
        // Collect model text
        for await (const chunk of reply.replyStream({
          key: geminiKey,
          seat: jasonSeat,
          contents,
          folderId: JASON_INBOX_FOLDER_ID,
          controller,
          timer,
          res: modelResult.res,
          instruction,
          record: async () => {},
        })) {
          try {
            const parsed = JSON.parse(chunk.trim());
            if (parsed.type === "done") {
              jasonResponse = parsed.reply;
            }
          } catch (_) {}
        }
      }
    } catch (modelErr) {
      console.error("Jason session invocation failed:", modelErr);
    }
  }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ok: true,
      timestamp: formattedTimestamp,
      file: createdFile,
      triageSummary: jasonResponse || "Email filed into Jason inbox.",
    }),
  };
};
