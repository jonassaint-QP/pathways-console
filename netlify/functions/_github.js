const { Octokit } = require("@octokit/rest");

const OWNER = "jonassaint-QP";
const REPOS = [
  "pathways-console",
  "QP-Store",
  "QP-Clinical",
  "QueerPathways",
  "QP-Backroom-v2",
  "QP-Backroom-Retired",
];
const ALLOWED_URL_HOSTS = [
  "queerpathways.com",
  "www.queerpathways.com",
  "queerpathways.org",
  "www.queerpathways.org",
  "queerpathways.info",
  "www.queerpathways.info",
];

const repoProperty = { type: "string", enum: REPOS, description: `Repository under ${OWNER}.` };
const branchProperty = { type: "string", description: "An existing branch name, not a commit SHA." };

const DECLARATIONS = [
  {
    name: "github_get_file",
    description: "Read a UTF-8 file or list a directory in one of Robert's managed repositories. Returns the file SHA needed for an update.",
    parameters: {
      type: "object",
      properties: {
        repo: repoProperty,
        path: { type: "string", description: "Repository-relative path; empty for the root directory." },
        ref: { type: "string", description: "Optional branch, tag or commit; defaults to the repository's default branch." },
      },
      required: ["repo", "path"],
    },
  },
  {
    name: "github_create_branch",
    description: "Create a working branch before changing files. Uses the default branch unless base is supplied.",
    parameters: {
      type: "object",
      properties: { repo: repoProperty, branch: branchProperty, base: branchProperty },
      required: ["repo", "branch"],
    },
  },
  {
    name: "github_write_file",
    description: "Create or update one UTF-8 file on an existing branch and commit it. Supply the current SHA from github_get_file when updating; omit SHA only for a new file.",
    parameters: {
      type: "object",
      properties: {
        repo: repoProperty, branch: branchProperty,
        path: { type: "string", description: "Repository-relative file path." },
        content: { type: "string", description: "Complete UTF-8 file contents, not a patch." },
        message: { type: "string", description: "Commit message." },
        sha: { type: "string", description: "Current file SHA for updates, read from the same branch." },
      },
      required: ["repo", "branch", "path", "content", "message"],
    },
  },
  {
    name: "github_open_pull_request",
    description: "Open a pull request from a working branch in the same repository. Does not merge or deploy. Base defaults to the repository's default branch.",
    parameters: {
      type: "object",
      properties: {
        repo: repoProperty, head: branchProperty, base: branchProperty,
        title: { type: "string" }, body: { type: "string" }, draft: { type: "boolean" },
      },
      required: ["repo", "head", "title", "body"],
    },
  },
  {
    name: "github_list_pull_requests",
    description: "List open, closed or all pull requests in one of Robert's managed repositories.",
    parameters: {
      type: "object",
      properties: {
        repo: repoProperty,
        state: { type: "string", enum: ["open", "closed", "all"], description: "Filter PRs by state; defaults to open." },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_list_commits",
    description: "List recent commits on a branch in one of Robert's managed repositories.",
    parameters: {
      type: "object",
      properties: {
        repo: repoProperty,
        branch: branchProperty,
        limit: { type: "integer", description: "Number of commits to return (1-30). Defaults to 10." },
        sha: { type: "string", description: "Branch name or commit SHA to inspect; defaults to the default branch." },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_get_tree",
    description: "Get the recursive file tree of a branch or commit in one of Robert's managed repositories.",
    parameters: {
      type: "object",
      properties: {
        repo: repoProperty,
        ref: { type: "string", description: "Branch name or commit SHA. Defaults to the default branch." },
        tree_sha: { type: "string", description: "Branch name or commit SHA to inspect; defaults to default branch." },
      },
      required: ["repo"],
    },
  },
  {
    name: "probe_url",
    description: "Probe a live Queer Pathways web surface (queerpathways.com, queerpathways.org, queerpathways.info) to verify HTTP status, canonical tags, and running artifact.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to inspect, scoped to queerpathways domains." },
      },
      required: ["url"],
    },
  },
];

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function path(value, allowRoot = false) {
  if (allowRoot && value === "") return "";
  const p = required(value, "path");
  if (p.startsWith("/") || p.includes("\\") || /[\x00-\x1f]/.test(p) ||
      p.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("path must be a repository-relative path without traversal.");
  }
  return p;
}

function branch(value, name) {
  const ref = required(value, name);
  if (/[\x00-\x20~^:?*[\]\\]/.test(ref) || ref.includes("..") || ref.includes("@{") ||
      ref === "@" || ref.startsWith("/") || ref.endsWith("/") ||
      ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) {
    throw new Error(`${name} must be a branch name in this repository.`);
  }
  return ref;
}

async function probeUrl(targetUrl, signal) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error("Invalid URL provided to probe_url.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http/https protocols are allowed.");
  }
  if (!ALLOWED_URL_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new Error(`Host ${parsed.hostname} is outside estate surfaces (${ALLOWED_URL_HOSTS.join(", ")}).`);
  }

  const response = await fetch(parsed.toString(), {
    method: "GET",
    headers: { "User-Agent": "QueerPathways-IT-Probe/1.0" },
    redirect: "follow",
    signal,
  });

  const bodyText = await response.text();
  const canonicalMatch = bodyText.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);

  return {
    status: response.status,
    statusText: response.statusText,
    finalUrl: response.url,
    redirected: response.redirected,
    contentType: response.headers.get("content-type"),
    title: titleMatch ? titleMatch[1].trim() : null,
    canonical: canonicalMatch ? canonicalMatch[1].trim() : null,
    contentLength: bodyText.length,
  };
}

async function execute(name, args, signal) {
  if (!DECLARATIONS.some((tool) => tool.name === name)) throw new Error(`Unknown GitHub action: ${name}.`);
  const a = args && typeof args === "object" ? args : {};

  if (name === "probe_url") {
    return await probeUrl(required(a.url, "url"), signal);
  }

  if (!REPOS.includes(a.repo)) throw new Error("That repository is outside Robert's repository scope.");
  const token = process.env.ROBERT_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("ROBERT_GITHUB_TOKEN or GITHUB_TOKEN is not set on the host. Robert cannot reach GitHub.");
  const octokit = new Octokit({ auth: token, request: { timeout: 15000 } });
  const common = { owner: OWNER, repo: a.repo, request: { signal } };
  const defaultBranch = async () => (await octokit.repos.get(common)).data.default_branch;

  if (name === "github_get_file") {
    const { data } = await octokit.repos.getContent({
      ...common, path: path(a.path, true), ...(a.ref ? { ref: required(a.ref, "ref") } : {}),
    });
    if (Array.isArray(data)) {
      return { entries: data.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type, sha: entry.sha })) };
    }
    if (data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string") {
      throw new Error("This path is not an inline-readable file. Use a smaller UTF-8 file.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data.content, "base64"));
    return { path: data.path, sha: data.sha, content: text, url: data.html_url };
  }

  if (name === "github_create_branch") {
    const workingBranch = branch(a.branch, "branch");
    const base = a.base ? branch(a.base, "base") : await defaultBranch();
    const { data: source } = await octokit.git.getRef({ ...common, ref: `heads/${base}` });
    const { data } = await octokit.git.createRef({ ...common, ref: `refs/heads/${workingBranch}`, sha: source.object.sha });
    return { ref: data.ref, sha: data.object.sha };
  }

  if (name === "github_write_file") {
    if (typeof a.content !== "string") throw new Error("content must be a string.");
    const { data } = await octokit.repos.createOrUpdateFileContents({
      ...common,
      path: path(a.path),
      branch: branch(a.branch, "branch"),
      message: required(a.message, "message"),
      content: Buffer.from(a.content, "utf8").toString("base64"),
      ...(a.sha ? { sha: required(a.sha, "sha") } : {}),
    });
    return { path: data.content?.path, sha: data.content?.sha, commit_sha: data.commit.sha, url: data.content?.html_url };
  }

  if (name === "github_open_pull_request") {
    const { data } = await octokit.pulls.create({
      ...common,
      head: branch(a.head, "head"),
      base: a.base ? branch(a.base, "base") : await defaultBranch(),
      title: required(a.title, "title"),
      body: typeof a.body === "string" ? a.body : required(a.body, "body"),
      draft: a.draft === true,
    });
    return { number: data.number, url: data.html_url, state: data.state };
  }

  if (name === "github_list_pull_requests") {
    const state = ["open", "closed", "all"].includes(a.state) ? a.state : "open";
    const { data } = await octokit.pulls.list({
      ...common,
      state,
      per_page: 20,
    });
    return {
      pull_requests: data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        head: pr.head.ref,
        base: pr.base.ref,
        draft: pr.draft,
        url: pr.html_url,
        html_url: pr.html_url,
        created_at: pr.created_at,
        merged_at: pr.merged_at,
      })),
    };
  }

  if (name === "github_list_commits") {
    const ref = a.branch ? branch(a.branch, "branch") : a.sha ? required(a.sha, "sha") : await defaultBranch();
    const per_page = Math.min(Math.max(Number(a.limit) || 10, 1), 30);
    const { data } = await octokit.repos.listCommits({
      ...common,
      sha: ref,
      per_page,
    });
    return {
      commits: data.map((c) => ({
        sha: c.sha.substring(0, 7),
        full_sha: c.sha,
        message: c.commit.message.split("\n")[0],
        author: c.commit.author?.name,
        date: c.commit.author?.date,
        url: c.html_url,
      })),
    };
  }

  if (name === "github_get_tree") {
    const ref = a.ref ? required(a.ref, "ref") : a.tree_sha ? required(a.tree_sha, "tree_sha") : await defaultBranch();
    const { data } = await octokit.git.getTree({
      ...common,
      tree_sha: ref,
      recursive: "true",
    });
    return {
      sha: data.sha,
      truncated: data.truncated,
      tree: data.tree.map((item) => ({ path: item.path, sha: item.sha, mode: item.mode, type: item.type, size: item.size })),
    };
  }

  throw new Error(`Unhandled action: ${name}`);
}

module.exports = { DECLARATIONS, execute, REPOS };
