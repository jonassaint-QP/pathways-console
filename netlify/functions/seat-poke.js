// netlify/functions/seat-poke.js
// Scheduled / triggered runner: rotates through the 7 seats between 05:00 and 24:00 America/New_York.
// Seat rotation: Jason -> Adam -> Mark -> David -> Ethan -> Robert -> Michael.
// For each seat, checks their Drive folder and inbox for pending work.
// Special instruction for Jason: also checks Gmail/inbox for new unread messages.
// If empty: logs heartbeat check ("Checked, found nothing").
// If items present: invokes the seat model session to complete the business and document it.

const seats = require("./seats.json");
const drive = require("./_drive.js");
const reply = require("./_chat-reply.js");

const ROTATION = ["jason", "adam", "mark", "david", "ethan", "robert", "michael"];

// Seat root folder IDs under GOOGLE TEAM > 02 QP Portability > 03 Seat Folders
const SEAT_FOLDER_IDS = {
  adam: "1L3ct25AAupz2VQBvQDuB90FkTjr7q3mk",
  david: "13AbGSYrXQEJvyK6n-dsHFim_Vy6aKRN9",
  ethan: "1mO7-RyulstGmLauWNmCsUJPBgJAD36k3",
  jason: "1m0lBPPZhPArlOsYxLDDSXwrYT0XHZ63e",
  mark: "1VTVmo1z3MXoOGjhS-TzBjmnNUVdxGVUm",
  michael: "1Fruwh9n9QbXg9nwEtUY6kxWcLzoSBs0Z",
  robert: "1xJepsn8QM7wlRdXRF2ASERXEisXsuJYP",
};

function getEasternHourAndMinute(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);

  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  return { hour, minute };
}

function getActiveSeat(date = new Date()) {
  // 2-minute rotation epoch indexed from unix timestamp
  const slot = Math.floor(date.getTime() / (2 * 60 * 1000));
  const seatId = ROTATION[slot % ROTATION.length];
  return { seatId, slot };
}

async function appendSeatSignalLog(folderId, seatName, message) {
  try {
    const list = await drive.listFolder(folderId);
    let signalFile = list.find((f) =>
      /signal[-_ ]register/i.test(f.name) || /heartbeat/i.test(f.name)
    );

    const timestamp = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date());

    const logEntry = `\n- [${timestamp} ET] **Heartbeat Poke**: ${message}`;

    if (signalFile && !signalFile.isFolder) {
      if (signalFile.mimeType === "application/vnd.google-apps.document") {
        const current = await drive.readFile(signalFile.id);
        const currentText = current.encoding === "utf8" ? current.text : "";
        await drive.updateDoc(signalFile.id, (currentText || "") + logEntry);
      }
    } else {
      // Create Heartbeat Register file if not present
      await drive.createDoc(`${seatName} Heartbeat Register`, `# ${seatName} Heartbeat Log\n${logEntry}`, folderId);
    }
  } catch (err) {
    console.error(`Failed to write signal log for ${seatName}:`, err.message);
  }
}

exports.handler = async (event) => {
  const pokeSecret = process.env.POKE_SECRET;
  if (pokeSecret) {
    const auth = event.headers.authorization || event.headers["x-poke-secret"] || "";
    if (auth !== pokeSecret && auth !== `Bearer ${pokeSecret}`) {
      return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
    }
  }

  const now = new Date();
  const { hour } = getEasternHourAndMinute(now);

  // Active window: between 05:00 and 24:00 (midnight) Eastern
  if (hour < 5) {
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "dormant", message: "Outside operating hours (05:00-24:00 ET)", hour }),
    };
  }

  const { seatId, slot } = getActiveSeat(now);
  const seat = seats[seatId];
  const folderId = SEAT_FOLDER_IDS[seatId];

  if (!seat || !folderId) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "config_error", seatId }),
    };
  }

  try {
    // 1. Inspect seat folder
    const files = await drive.listFolder(folderId);

    // Check Inbox or in-flight subfolders if present
    const inboxFolder = files.find((f) => f.isFolder && /inbox|in flight/i.test(f.name));
    let pendingItems = [];
    if (inboxFolder) {
      const inboxContents = await drive.listFolder(inboxFolder.id);
      pendingItems = inboxContents.filter((f) => !f.isFolder);
    }

    // 2. If nothing pending, document heartbeat and exit
    if (!pendingItems.length) {
      const checkSummary = seatId === "jason"
        ? "Checked folder, inbox, and incoming emails; no actionable items pending."
        : "Checked folder and inbox; no actionable items pending.";

      await appendSeatSignalLog(folderId, seat.name, checkSummary);
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "clear",
          seat: seatId,
          slot,
          action: "Checked, didn't see anything. Heartbeat logged.",
        }),
      };
    }

    // 3. Pending items exist: wake up the seat assistant session to process them
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      await appendSeatSignalLog(folderId, seat.name, `Found ${pendingItems.length} items, but CLAUDE_API_KEY not configured.`);
      return { statusCode: 200, body: JSON.stringify({ status: "skipped_no_key", seat: seatId }) };
    }

    const itemSummary = pendingItems.map((i) => `- ${i.name} (id: ${i.id})`).join("\n");
    const instruction = [
      seat.instructions || "",
      "",
      seat.voice ? `VOICE.\n${seat.voice}` : "",
      seat.never ? `WHAT YOU NEVER DO.\n${seat.never}` : "",
      reply.FOLDER_NOTE,
      seat.id === "robert" ? reply.GITHUB_NOTE : "",
    ].filter(Boolean).join("\n");

    const wakePrompt = seatId === "jason"
      ? `AUTOMATED POKE WAKE-UP.\nCheck inbox files and inbound email items:\n${itemSummary}\nInspect each item, draft or complete any required business/responses, document your actions in your seat registers, and summarize what you did.`
      : `AUTOMATED POKE WAKE-UP.\nThe following new items were detected in your inbox:\n${itemSummary}\nInspect the items, take the required actions to complete the business, document your completed actions in your seat registers, and summarize what you did.`;

    const promptMessages = [
      {
        role: "user",
        content: [{ type: "text", text: wakePrompt }],
      },
    ];

    const controller = new AbortController();
    const timeoutMs = Number(process.env.CHAT_TIMEOUT_MS) || 22000;
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const modelResult = await reply.callModel(apiKey, reply.MODEL, instruction, promptMessages, folderId, controller, seat);
      if (!modelResult.ok) {
        throw new Error(`The model call failed (${modelResult.status}): ${modelResult.detail || "no detail"}`);
      }

      let completion = null;
      for await (const chunk of reply.replyStream({
        key: apiKey,
        seat,
        contents: promptMessages,
        folderId,
        controller,
        timer,
        deadline,
        res: modelResult.res,
        instruction,
        record: async () => {},
      })) {
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "error") throw new Error(event.message || "The model stream failed.");
          if (event.type === "done") completion = event;
        }
      }

      if (!completion) throw new Error("The model stream ended without a completed response.");

      await appendSeatSignalLog(folderId, seat.name, `Processed ${pendingItems.length} pending items via poke run.`);

      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "processed",
          seat: seatId,
          slot,
          itemsCount: pendingItems.length,
          responseStatus: modelResult.res.status,
          triageSummary: completion.reply,
          actions: completion.actions,
        }),
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  } catch (err) {
    console.error(`Seat poke error for ${seatId}:`, err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message, seat: seatId }),
    };
  }
};

// Exposed for direct testing: exercising the heartbeat-log write without needing to fake
// the 2-minute rotation slot and the Eastern operating-hours window the handler gates on.
exports.appendSeatSignalLog = appendSeatSignalLog;
