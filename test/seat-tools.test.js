const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");

function load(file, overrides = {}) {
  const context = {
    module: { exports: {} }, require, Buffer, URLSearchParams, TextDecoder,
    process: { env: {} }, ...overrides,
  };
  context.exports = context.module.exports;
  vm.runInNewContext(fs.readFileSync(require.resolve(`../netlify/functions/${file}`), "utf8"), context);
  return context.module.exports;
}

test("Drive signs a delegated JWT and creates documents in the explicit or configured folder", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = {
    GOOGLE_SA_KEY_JSON: JSON.stringify({
      client_email: "service-account@example.test",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
    GOOGLE_DRIVE_FOLDER_ID: "default_folder",
  };
  const requests = [];
  const drive = load("_drive.js", {
    process: { env },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(url.includes("oauth2")
        ? { access_token: "synthetic-access-token", expires_in: 3600 }
        : { id: "created_doc", webViewLink: "https://example.test/doc" }));
    },
  });
  await drive.createDoc("Title", "Body", "bound_folder");
  await drive.createDoc("Title", "Body");
  const assertion = requests[0].init.body.get("assertion");
  const [header, claims, signature] = assertion.split(".");
  const claim = JSON.parse(Buffer.from(claims, "base64url"));
  assert.equal(claim.sub, "jonassaint@queerpathways.org");
  assert.equal(claim.iss, "service-account@example.test");
  assert.equal(claim.scope, "https://www.googleapis.com/auth/drive");
  assert.equal(crypto.verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")), true);
  const creates = requests.filter((r) => r.url.includes("/drive/v3/files?"));
  assert.deepEqual(creates.map((r) => JSON.parse(r.init.body).parents), [["bound_folder"], ["default_folder"]]);
  assert.ok(creates.every((r) => r.url.includes("supportsAllDrives=true")));
  assert.equal(requests.filter((r) => r.url.includes("oauth2")).length, 1);
  delete env.GOOGLE_DRIVE_FOLDER_ID;
  const count = requests.length;
  await assert.rejects(drive.createDoc("Title", "Body"), /folder id is required/);
  assert.equal(requests.length, count);
});

function github(env = { ROBERT_GITHUB_TOKEN: "synthetic-robert-token", GITHUB_TOKEN: "synthetic-fallback" }) {
  const calls = [], clients = [];
  const method = (name, data) => async (args) => {
    calls.push({ name, args });
    return { data };
  };
  class Octokit {
    constructor(options) {
      clients.push(options);
      this.repos = {
        get: method("getRepo", { default_branch: "trunk" }),
        getContent: method("getContent", {
          type: "file", encoding: "base64", content: Buffer.from("File contents").toString("base64"),
          path: "src/app.js", sha: "old-sha", html_url: "https://example.test/file",
        }),
        createOrUpdateFileContents: method("write", {
          content: { path: "src/app.js", sha: "new-sha", html_url: "https://example.test/file" },
          commit: { sha: "commit-sha" },
        }),
      };
      this.git = {
        getRef: method("getRef", { object: { sha: "base-sha" } }),
        createRef: method("createRef", { ref: "refs/heads/work", object: { sha: "base-sha" } }),
      };
      this.pulls = { create: method("pull", { number: 42, html_url: "https://example.test/pr", state: "open" }) };
    }
  }
  return {
    api: load("_github.js", { process: { env }, require: () => ({ Octokit }) }),
    calls, clients,
  };
}

test("GitHub reads, branches, writes UTF-8 files with SHA and opens same-repo PRs", async () => {
  const { api, calls, clients } = github();
  const signal = new AbortController().signal;
  const file = await api.execute("github_get_file", { repo: "QP-Store", path: "src/app.js", ref: "work" }, signal);
  assert.equal(file.content, "File contents");
  assert.equal(file.sha, "old-sha");
  await api.execute("github_create_branch", { repo: "QP-Store", branch: "work" }, signal);
  await api.execute("github_write_file", {
    repo: "QP-Store", branch: "work", path: "src/app.js", content: "Updated", sha: file.sha, message: "Update",
  }, signal);
  const pr = await api.execute("github_open_pull_request", {
    repo: "QP-Store", head: "work", title: "Update", body: "Changes", draft: true,
  }, signal);
  assert.equal(pr.number, 42);
  assert.ok(clients.every((c) => c.auth === "synthetic-robert-token"));
  assert.ok(calls.every((c) => c.args.owner === "jonassaint-QP" && c.args.request.signal === signal));
  assert.equal(calls.find((c) => c.name === "getRef").args.ref, "heads/trunk");
  assert.equal(calls.find((c) => c.name === "createRef").args.ref, "refs/heads/work");
  const write = calls.find((c) => c.name === "write").args;
  assert.equal(write.sha, "old-sha");
  assert.equal(Buffer.from(write.content, "base64").toString(), "Updated");
  const pull = calls.find((c) => c.name === "pull").args;
  assert.equal(pull.base, "trunk");
  assert.equal(pull.draft, true);
});

test("GitHub is restricted to the four repos, requires credentials and propagates failures", async () => {
  const { api, calls } = github();
  await assert.rejects(api.execute("github_get_file", { repo: "unrelated", path: "" }), /outside/);
  await assert.rejects(api.execute("github_write_file", { repo: "QP-Store", path: "../secrets", branch: "work", content: "", message: "Update" }), /traversal/);
  await assert.rejects(api.execute("github_open_pull_request", { repo: "QP-Store", head: "outsider:work", title: "Update", body: "" }), /branch name/);
  assert.equal(calls.length, 0);
  await assert.rejects(github({}).api.execute("github_get_file", { repo: "QP-Store", path: "" }), /TOKEN/);
  const fallback = github({ GITHUB_TOKEN: "synthetic-fallback" });
  await fallback.api.execute("github_get_file", { repo: "QP-Store", path: "" });
  assert.equal(fallback.clients[0].auth, "synthetic-fallback");
  const failed = load("_github.js", {
    process: { env: { GITHUB_TOKEN: "synthetic" } },
    require: () => ({ Octokit: class {
      constructor() { this.repos = { getContent: async () => { throw new Error("Bad credentials"); } }; }
    } }),
  });
  await assert.rejects(failed.execute("github_get_file", { repo: "QP-Store", path: "" }), /Bad credentials/);
});

test("real Octokit serializes a branch-specific update without exposing credentials in its body", async () => {
  const { Octokit } = require("@octokit/rest");
  const requests = [];
  class LocalOctokit extends Octokit {
    constructor(options) {
      super({
        ...options,
        request: {
          ...options.request,
          fetch: async (url, init) => {
            requests.push({ url, init });
            return new Response(JSON.stringify({
              content: { path: "src/app.js", sha: "new-sha" }, commit: { sha: "commit-sha" },
            }), { status: 200, headers: { "content-type": "application/json" } });
          },
        },
      });
    }
  }
  const api = load("_github.js", {
    process: { env: { ROBERT_GITHUB_TOKEN: "synthetic-token" } },
    require: () => ({ Octokit: LocalOctokit }),
  });
  await api.execute("github_write_file", {
    repo: "QP-Clinical", path: "src/app.js", branch: "robert/work",
    message: "Update", content: "Updated file", sha: "old-sha",
  });
  assert.equal(requests[0].url, "https://api.github.com/repos/jonassaint-QP/QP-Clinical/contents/src%2Fapp.js");
  assert.equal(requests[0].init.method, "PUT");
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.sha, "old-sha");
  assert.equal(body.branch, "robert/work");
  assert.doesNotMatch(requests[0].init.body, /synthetic-token/);
});

test("seat execution rejects unregistered actions and creates Drive documents in the bound folder", async () => {
  const requests = [];
  const gh = github().api;
  const tools = load("_seat-tools.js", {
    require: (name) => name === "./_github" ? gh : {
      createDoc: async (...args) => { requests.push(args); return { id: "new_doc", url: "https://example.test" }; },
    },
  });
  await assert.rejects(tools.executeForSeat({ id: "jason" }, "folder123", "github_get_file", {}), /not available/);
  await assert.rejects(tools.executeForSeat({ id: "robert" }, "", "list_folder", {}), /not available/);
  const result = await tools.executeForSeat({ id: "robert" }, "folder123", "create_document", { title: "Title", text: "Body" });
  assert.deepEqual(requests[0], ["Title", "Body", "folder123"]);
  assert.equal(result.filed_in, "folder123");
});

test("finance create and collect pass the bound folder and report the document as filed", async () => {
  const requests = [];
  const finance = load("finance-run.js", {
    require: (name) => name === "./_auth" ? { guard: () => null } : {
      createDoc: async (...args) => { requests.push(args); return { id: "new_doc" }; },
    },
  });
  for (const action of ["create", "collect"]) {
    const result = await finance.handler({
      httpMethod: "POST",
      body: JSON.stringify({ action, folderId: "bound_folder", title: "Title", text: "Body" }),
    });
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).filed, true);
  }
  assert.deepEqual(requests, [["Title", "Body", "bound_folder"], ["Title", "Body", "bound_folder"]]);
});
