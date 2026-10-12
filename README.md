# Pathways Console — Netlify build

**One site. Two front doors. One key.**

The console (private, seven seats) and the website assistant (public, one brief) run as Netlify Functions
on the same site. The console (`chat.js`) and image generation (`visual.js`) read `GEMINI_API_KEY`. The
public widget (`assistant.js`) reads `ANTHROPIC_API_KEY` and runs on Claude instead.

---

## What is in here

| Path | What it is |
|---|---|
| `public/index.html` | The console. Side rail of seven seats on desktop, seat switcher on mobile. |
| `public/assistant-widget.js` | The public website widget. **Not switched on.** |
| `netlify/functions/seats.js` | `GET /api/seats` → the seven seats. |
| `netlify/functions/chat.js` | `POST /api/chat` → the console's private NDJSON response stream. |
| `public/chat-stream.js` | Reads response chunks and requires a final completion event. |
| `netlify/functions/assistant.js` | `POST /api/assistant` → the public widget. **Inert until switched on.** |
| `netlify/functions/seats.json` | **The seven seats.** The file is the seat. |
| `netlify/functions/assistant-brief.js` | The reception brief and its configuration block. |
| `netlify.toml` | Routes, functions directory, publish directory. |

---

## To deploy

1. **Connect this folder to a Netlify site** (drag-and-drop, or point it at a repo).
   - Build command: **leave empty**
   - Publish directory: **`public`**
   - Functions directory: **`netlify/functions`** — set in `netlify.toml` already
2. **Environment variables on that site:**
   - `GEMINI_API_KEY` — powers the console (`chat.js`) and image generation (`visual.js`). **Already
     present in the existing project.** If this is a *new* site, add it there.
   - `ANTHROPIC_API_KEY` — powers the public widget (`assistant.js`) only, which runs on Claude.
   - `ASSISTANT_ENABLED` — **leave unset.** The public widget refuses until this is `"true"`.
3. **Deploy.** The console is at the site root.

---

## Seat access to Drive and GitHub

Drive uses `GOOGLE_SA_KEY_JSON` (raw or base64-encoded service-account JSON) and a signed JWT
with `sub: jonassaint@queerpathways.org`. Enable domain-wide delegation for the service account
in Google Cloud, then have a Workspace administrator authorize its OAuth client ID for
`https://www.googleapis.com/auth/drive` in the Admin console. The impersonated user must have
access to the target folder; delegation alone does not grant folder access.

Documents are created directly inside the operator-bound folder, with `parents` set on creation
and `supportsAllDrives=true`. The shared helper falls back to `GOOGLE_DRIVE_FOLDER_ID` only when
called without a folder; chat and `finance-run` pass their bound folder explicitly. The finance
`create` and `collect` actions now both return `filed: true` without a separate move.

Robert receives `github_get_file`, `github_create_branch`, `github_write_file`, and
`github_open_pull_request`, with or without a Drive folder. Other seats do not receive or execute
these actions. Repository access is restricted server-side to `jonassaint-QP/pathways-console`,
`jonassaint-QP/QP-Store`, `jonassaint-QP/QP-Clinical`, and `jonassaint-QP/QueerPathways`.

Set `ROBERT_GITHUB_TOKEN` as a secret function environment variable (preferred); `GITHUB_TOKEN`
is the fallback. Use a fine-grained token scoped to those four repositories with Contents
read/write and Pull requests read/write permissions, and Metadata read access. Missing or refused
credentials return action errors rather than empty success. Tokens never go into model tool arguments.
File writes commit complete UTF-8 contents on a named branch; updates require the current file SHA.
The tools can create working branches and open pull requests, but do not merge or deploy.
Creating a pull request or committing code is not proof that a change is live.

---

## Two switches, and only one of them is yours today

**The console works as soon as the site exists.** It is private: no index, no links, unguessable URL.
`noindex,nofollow` is set in the page head.

**The public assistant does not work, on purpose.** `assistant.js` refuses every request unless
`ASSISTANT_ENABLED=true` is set on the host. That means the route can be tested and cannot answer a stranger
by accident. Two things must happen first:

1. **Compliance clearance** — it creates a new public surface, which is a founder item by the standing rule.
2. **The configuration block filled in** — `rates`, `jurisdictions` and `insurers` in `assistant-brief.js` are
   **empty on purpose**, so the assistant says it cannot confirm a figure rather than inventing one.

---

## The records — two copies of every exchange, written server-side

**Every message you send and every answer a seat gives is recorded at the moment it happens. Nothing is moved by
hand.**

**Copy one — the seat's own ongoing record.** One file per seat per day:
`jason/2026-10-06.md`, `adam/2026-10-06.md`, and so on. **The seat keeps the history of its conversations with the
operator**, appended as they happen.

**Copy two — Adam's record.** One file per month holding every exchange with every seat: `2026-10.md`. **This is
the compliance record** — the incoming Chief Compliance Officer's view of everything said through the console.

**Both live server-side in Netlify Blobs** — built into the platform, no external database and no credentials. And
both are readable from inside the console: **the Records button** at the top of the conversation opens them, and
either seat or Adam can be viewed and copied out.

| Route | What it does |
|---|---|
| `GET /api/transcripts?seat=jason` | Lists that seat's record files |
| `GET /api/transcripts?seat=jason&file=2026-10-06.md` | Returns the file as markdown |
| `GET /api/transcripts?list=adam` | Lists Adam's record files |
| `GET /api/transcripts?adam=1&file=2026-10.md` | Returns Adam's file as markdown |

**A write failure never blocks a reply.** If the record cannot be written, the answer still comes back and the
failure is logged and shown in the console — a lost write should not look like a failed conversation.

**Console answers stream as they arrive.** The model uses temperature `0.7` and a maximum of `8192` output
tokens. `/api/chat` emits newline-delimited JSON: `delta` events contain text, `done` contains the full
`reply` and `recorded` keys, and `error` reports an incomplete answer. HTTP errors before streaming still
return JSON. Netlify's streaming wrapper awaits the entire response pipeline, including record writes and
the final event; the Lambda context does not wait for unrelated open sockets. The browser saves an answer
to the originating seat's in-memory thread only after receiving the final event and a clean end of stream.
Interrupted or output-limited replies remain visible as incomplete and are not recorded as complete exchanges.
Streaming remains subject to the deployed site's function execution limits; the model request has a
45-second application timeout. Netlify's [Lambda streaming documentation](https://docs.netlify.com/build/functions/lambda-compatibility/#response-streaming)
lists a 10-second streaming limit. The context flag cannot extend a platform timeout; confirm the site's
effective limit before relying on longer answers. Local checks cannot verify the deployed Netlify proxy's behavior.

**This does NOT apply to the public widget.** `assistant.js` still stores nothing, by design. **The privacy promise
belongs to the stranger, not to the operator.** The console records because it is private and yours; the widget
records nothing because it meets people who did not ask to be kept.

---

## What was verified, and what was not

**Verified by running the logic locally:** the server boots, the seven seats load and serve, the console renders,
and both API routes fail closed and loudly — **503 with "No GEMINI_API_KEY set on the host"** for the console
when its key is absent, and the assistant refusing with "not switched on" regardless.

**Not verified: the model call itself**, because no key is reachable from the build seat. **That is the only
unverified piece, and it is unverified for one reason.**

---

## Not built yet, in the order it gets added

**Persistence** — threads die with the tab. This is first, because everything else gets tested against history.
**Handoffs** — no seat can yet write a task another seat reads. This is the routing the console exists for.
**File drop** — hand a seat a document and have it answer from that.
**Scheduled runs.** **Voice**, last, deliberately.

---

## The rule the app is built to

**Nothing is stored.** No database, no cookies, no localStorage, no transcript on disk. The conversation lives in
memory for the tab and dies with it. **Information that is not needed is not collected.**

---

Prepared by the executive seat, 6 October 2026. Internal. No key material appears in this folder.
