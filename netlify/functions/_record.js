// Shared transcript store. Server-side, so nothing has to be moved by hand.
//
// Two copies of every exchange, by design:
//   1. seats.store  key: "<seatId>/<YYYY-MM-DD>.md"   -> the seat's own ongoing record
//   2. adam.store   key: "<YYYY-MM>.md"               -> the compliance record of everything said
//
// Backed by Netlify Blobs (built into the platform). No external database, no credentials.
const { getStore } = require("@netlify/blobs");

const SEAT_STORE = "qp-seat-records";
const ADAM_STORE = "qp-adam-record";

function day(d) { return new Date(d).toISOString().slice(0, 10); }
function month(d) { return new Date(d).toISOString().slice(0, 7); }

function stamp(d) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())} UTC`;
}

function header(seat, title) {
  return [
    `# ${title}`,
    ``,
    `**Seat:** ${seat.name} — ${seat.title || ""}  `,
    `**Record opened:** ${stamp(Date.now())}  `,
    `**Surface:** Pathways Console (private).  `,
    ``,
    `> Every exchange in this file is a copy. The compliance record holds the same exchanges under Adam.`,
    ``,
    `---`,
    ``,
  ].join("\n");
}

function fmt(seat, userText, replyText) {
  return [
    `### ${seat.name} · ${stamp(Date.now())}`,
    ``,
    `**Operator:**`,
    ``,
    userText,
    ``,
    `**${seat.name}:**`,
    ``,
    replyText,
    ``,
    `---`,
    ``,
  ].join("\n");
}

// append to a store key, creating with a header if it does not exist
async function append(store, key, body, makeHeader) {
  let existing = "";
  try { const got = await store.get(key); if (got) existing = typeof got === "string" ? got : await got.text(); }
  catch { existing = ""; }
  const next = existing ? existing + body : makeHeader() + body;
  await store.set(key, next);
  return next.length;
}

async function ensureAdam() {
  return getStore({ name: ADAM_STORE, consistency: "strong" });
}
async function ensureSeats() {
  return getStore({ name: SEAT_STORE, consistency: "strong" });
}

// The one call chat.js makes. Writes both copies.
async function record(seat, userText, replyText) {
  const now = Date.now();
  const seats = await ensureSeats();
  const adam = await ensureAdam();

  const seatKey = `${seat.id}/${day(now)}.md`;
  await append(
    seats, seatKey,
    fmt(seat, userText, replyText),
    () => header(seat, `${seat.name} — ongoing record of communications`)
  );

  const adamKey = `${month(now)}.md`;
  await append(
    adam, adamKey,
    fmt(seat, userText, replyText),
    () => [
      `# Compliance record — every exchange, all seats`,
      ``,
      `**Held by:** Adam — Chief Compliance Officer (incoming seat).  `,
      `**Record opened:** ${stamp(now)}  `,
      `**Source:** copies of the Pathways Console conversations, written at the moment of the exchange.  `,
      ``,
      `> Read by the seven-seat estate. This is the record of what was asked and answered, not a clinical`,
      `> record. No client identifiers are expected in this surface, and none are added by this code.`,
      ``,
      `---`,
      ``,
    ].join("\n")
  );

  return { seatKey, adamKey };
}

module.exports = { record, getStore, SEAT_STORE, ADAM_STORE, day, month, stamp, header };
