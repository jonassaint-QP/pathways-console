// Netlify API integration for querying deploy status and running artifacts across estate sites.

const NETLIFY_API_BASE = "https://api.netlify.com/api/v1";

const KNOWN_SITES = {
  "pathways-console": process.env.NETLIFY_SITE_ID_CONSOLE || "luminous-cactus-fd7663.netlify.app",
  "QP-Store": process.env.NETLIFY_SITE_ID_STORE || "queerpathways.com",
  "QP-Clinical": process.env.NETLIFY_SITE_ID_CLINICAL || "queerpathways.org",
  "QueerPathways": process.env.NETLIFY_SITE_ID_LEGACY || "queerpathways.info",
};

const DECLARATIONS = [
  {
    name: "netlify_get_deploy_status",
    description: "Get recent deploy status, build state, and running commit for an estate site on Netlify.",
    parameters: {
      type: "object",
      properties: {
        site: {
          type: "string",
          enum: ["pathways-console", "QP-Store", "QP-Clinical", "QueerPathways"],
          description: "Estate site identifier.",
        },
      },
      required: ["site"],
    },
  },
  {
    name: "netlify_list_sites",
    description: "List all accessible Netlify sites and their currently published deploy states.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

function getToken() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    throw new Error("NETLIFY_AUTH_TOKEN is not configured on the host. Netlify status is unreachable.");
  }
  return token;
}

async function netlifyFetch(endpoint, signal) {
  const token = getToken();
  const response = await fetch(`${NETLIFY_API_BASE}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "QueerPathways-IT-Manager/1.0",
    },
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Netlify API error (${response.status}): ${errorText || response.statusText}`);
  }

  return response.json();
}

async function listSites(signal) {
  const sites = await netlifyFetch("/sites", signal);
  return {
    sites: sites.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      ssl_url: s.ssl_url,
      custom_domain: s.custom_domain,
      updated_at: s.updated_at,
      published_deploy: s.published_deploy ? {
        id: s.published_deploy.id,
        state: s.published_deploy.state,
        branch: s.published_deploy.branch,
        commit_ref: s.published_deploy.commit_ref ? s.published_deploy.commit_ref.substring(0, 7) : null,
        title: s.published_deploy.title,
        created_at: s.published_deploy.created_at,
      } : null,
    })),
  };
}

async function getDeployStatus(siteKey, signal) {
  const allSites = await netlifyFetch("/sites", signal);
  const target = KNOWN_SITES[siteKey] || siteKey;

  // Resolve matching site by domain, slug, or ID
  const matched = allSites.find((s) =>
    s.id === target ||
    s.name === target ||
    s.custom_domain === target ||
    (s.url && s.url.includes(target)) ||
    (s.ssl_url && s.ssl_url.includes(target))
  );

  if (!matched) {
    return {
      error: `Could not match site '${siteKey}' in accessible Netlify sites.`,
      available_sites: allSites.map((s) => ({ id: s.id, name: s.name, custom_domain: s.custom_domain, url: s.url })),
    };
  }

  const deploys = await netlifyFetch(`/sites/${matched.id}/deploys?per_page=5`, signal);

  return {
    site_id: matched.id,
    site_name: matched.name,
    custom_domain: matched.custom_domain,
    url: matched.ssl_url || matched.url,
    recent_deploys: deploys.map((d) => ({
      id: d.id,
      state: d.state,
      context: d.context,
      branch: d.branch,
      commit_ref: d.commit_ref ? d.commit_ref.substring(0, 7) : null,
      commit_url: d.commit_url,
      title: d.title,
      error_message: d.error_message,
      created_at: d.created_at,
      published_at: d.published_at,
      deploy_time: d.deploy_time,
    })),
  };
}

async function execute(name, args, signal) {
  if (!DECLARATIONS.some((tool) => tool.name === name)) {
    throw new Error(`Unknown Netlify action: ${name}.`);
  }
  const a = args && typeof args === "object" ? args : {};

  if (name === "netlify_list_sites") {
    return await listSites(signal);
  }

  if (name === "netlify_get_deploy_status") {
    if (!a.site) throw new Error("site is required.");
    return await getDeployStatus(a.site, signal);
  }

  throw new Error(`Unhandled action: ${name}`);
}

module.exports = { DECLARATIONS, execute };
