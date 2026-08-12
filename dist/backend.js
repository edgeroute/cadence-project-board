"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/backend/server.ts
var import_http = __toESM(require("http"));
var import_path2 = __toESM(require("path"));
var import_fs2 = __toESM(require("fs"));
var import_url = require("url");

// src/backend/config.service.ts
var import_path = __toESM(require("path"));
var import_fs = require("fs");
var CONFIG_DIR = ".CadenceBoard";
var CONFIG_FILE = import_path.default.join(CONFIG_DIR, "project-board.json");
var NotConfiguredError = class extends Error {
  notConfigured = true;
};
function envToken() {
  const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return t && t.trim() ? t.trim() : null;
}
async function readConfig(projectPath) {
  if (!projectPath) throw new NotConfiguredError("No project is open.");
  let parsed = null;
  try {
    const raw = await import_fs.promises.readFile(import_path.default.join(projectPath, CONFIG_FILE), "utf8");
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || !parsed.owner || !parsed.projectNumber) {
    throw new NotConfiguredError(
      "This project has no board configured yet. Add the owner and project number in Settings."
    );
  }
  const fileToken = parsed.token?.trim();
  const token = fileToken || envToken();
  if (!token) {
    throw new NotConfiguredError(
      "No GitHub token. Add one in Settings, or set GH_TOKEN in the environment claudecodeui runs in."
    );
  }
  return {
    token,
    owner: parsed.owner,
    projectNumber: Number(parsed.projectNumber),
    enabled: parsed.enabled !== false,
    tokenSource: fileToken ? "config" : "env"
  };
}
async function publicConfig(projectPath) {
  let parsed = null;
  try {
    const raw = await import_fs.promises.readFile(import_path.default.join(projectPath, CONFIG_FILE), "utf8");
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const tokenSource = parsed?.token?.trim() ? "config" : envToken() ? "env" : "none";
  return {
    owner: parsed?.owner ?? "",
    projectNumber: parsed?.projectNumber ?? null,
    enabled: parsed?.enabled !== false,
    tokenSource
  };
}
async function ensureGitignored(projectPath) {
  const gitignore = import_path.default.join(projectPath, ".gitignore");
  const entry = `${CONFIG_DIR}/`;
  try {
    let current = "";
    try {
      current = await import_fs.promises.readFile(gitignore, "utf8");
    } catch {
      current = "";
    }
    const already = current.split("\n").map((l) => l.trim()).some((l) => l === entry || l === CONFIG_DIR);
    if (already) return true;
    const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    await import_fs.promises.appendFile(
      gitignore,
      `${prefix}
# Project Board plugin \u2014 holds a GitHub token
${entry}
`,
      "utf8"
    );
    return true;
  } catch {
    return false;
  }
}
async function writeConfig(projectPath, input) {
  if (!projectPath) throw new Error("No project is open.");
  if (!input.owner?.trim()) throw new Error("An owner is required.");
  if (!input.projectNumber) throw new Error("A project number is required.");
  const dir = import_path.default.join(projectPath, CONFIG_DIR);
  await import_fs.promises.mkdir(dir, { recursive: true });
  let existing = null;
  try {
    existing = JSON.parse(await import_fs.promises.readFile(import_path.default.join(projectPath, CONFIG_FILE), "utf8"));
  } catch {
    existing = null;
  }
  const token = input.token?.trim() || existing?.token || void 0;
  const body = {
    owner: input.owner.trim(),
    projectNumber: Number(input.projectNumber),
    enabled: input.enabled !== false
  };
  if (token) body.token = token;
  const gitignored = await ensureGitignored(projectPath);
  await import_fs.promises.writeFile(import_path.default.join(projectPath, CONFIG_FILE), JSON.stringify(body, null, 2) + "\n", {
    encoding: "utf8",
    // 0600: the file holds a token and lives in a directory the reader may well share
    // over a network mount. Node applies this only on create, which is the case that
    // matters — an existing file keeps whatever the reader set.
    mode: 384
  });
  return { gitignored };
}

// src/backend/project.service.ts
var GRAPHQL = "https://api.github.com/graphql";
var REST = "https://api.github.com";
var PAGE_SIZE = 100;
var MAX_PAGES = 10;
var GitHubError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
};
async function graphql(token, query2, variables) {
  let res;
  try {
    res = await fetch(GRAPHQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json"
      },
      body: JSON.stringify({ query: query2, variables })
    });
  } catch (e) {
    throw new GitHubError(`Could not reach GitHub: ${e.message}`);
  }
  if (res.status === 401) throw new GitHubError("GitHub rejected the token (401). Check it in Settings.", 401);
  const json = await res.json().catch(() => null);
  if (!json) throw new GitHubError(`GitHub returned an unreadable response (${res.status}).`, res.status);
  if (json.errors?.length) {
    if (json.errors.some((e) => e.type === "INSUFFICIENT_SCOPES")) {
      throw new GitHubError(
        "This token cannot read Projects. It needs a classic personal access token with both `repo` and `project` scopes \u2014 fine-grained tokens cannot access user-owned projects at all.",
        403
      );
    }
    throw new GitHubError(json.errors.map((e) => e.message).join("; "), res.status);
  }
  if (!json.data) throw new GitHubError(`GitHub returned no data (${res.status}).`, res.status);
  return json.data;
}
var ownerTypes = /* @__PURE__ */ new Map();
async function resolveOwnerRoot(token, login) {
  const cached = ownerTypes.get(login);
  if (cached) return cached;
  const res = await fetch(`${REST}/users/${encodeURIComponent(login)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
  }).catch((e) => {
    throw new GitHubError(`Could not reach GitHub: ${e.message}`);
  });
  if (res.status === 404) throw new GitHubError(`No GitHub account called "${login}".`, 404);
  if (!res.ok) throw new GitHubError(`Could not look up "${login}" (${res.status}).`, res.status);
  const body = await res.json();
  const root = body.type === "Organization" ? "organization" : "user";
  ownerTypes.set(login, root);
  return root;
}
var BOARD_QUERY = (root) => `
query($login:String!, $number:Int!, $cursor:String) {
  ${root}(login:$login) {
    projectV2(number:$number) {
      id
      title
      url
      fields(first:50) {
        nodes {
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
      }
      items(first:${PAGE_SIZE}, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            ... on DraftIssue { title }
            ... on Issue {
              number title body state url updatedAt
              repository { nameWithOwner }
              author { login avatarUrl }
              labels(first:10) { nodes { name color } }
              assignees(first:5) { nodes { login avatarUrl } }
              comments { totalCount }
            }
            ... on PullRequest {
              number title body state url updatedAt
              repository { nameWithOwner }
              author { login avatarUrl }
              labels(first:10) { nodes { name color } }
              assignees(first:5) { nodes { login avatarUrl } }
              comments { totalCount }
            }
          }
          fieldValues(first:20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                optionId
                field { ... on ProjectV2FieldCommon { id } }
              }
            }
          }
        }
      }
    }
  }
}`;
function toContent(raw) {
  const c = raw.content;
  if (!c) return { content: null, draftTitle: null };
  if (c.number === void 0) return { content: null, draftTitle: c.title ?? null };
  return {
    draftTitle: null,
    content: {
      number: c.number,
      title: c.title ?? "",
      body: c.body ?? null,
      state: c.state ?? "OPEN",
      url: c.url ?? "",
      updatedAt: c.updatedAt ?? "",
      repository: c.repository?.nameWithOwner ?? "",
      author: c.author ?? null,
      labels: c.labels?.nodes ?? [],
      assignees: c.assignees?.nodes ?? [],
      comments: c.comments?.totalCount ?? 0,
      // `state` is OPEN/CLOSED on an issue and OPEN/CLOSED/MERGED on a PR, so MERGED
      // is the only unambiguous tell available from the fields this query asks for.
      // Everything else about a PR reads identically to an issue.
      isPullRequest: c.state === "MERGED"
    }
  };
}
async function fetchBoard(config) {
  const root = await resolveOwnerRoot(config.token, config.owner);
  const query2 = BOARD_QUERY(root);
  let cursor = null;
  let fields = [];
  const items = [];
  let projectId = "";
  let title = "";
  let url = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(config.token, query2, {
      login: config.owner,
      number: config.projectNumber,
      cursor
    });
    const project = data[root]?.projectV2;
    if (!project) {
      throw new GitHubError(
        `No project number ${config.projectNumber} on ${config.owner}. Check the number in Settings \u2014 it is the one in the project's URL.`,
        404
      );
    }
    if (page === 0) {
      projectId = project.id;
      title = project.title;
      url = project.url;
      fields = project.fields.nodes.filter(
        (f) => Boolean(f.id && f.name && f.options)
      ).map((f) => ({ id: f.id, name: f.name, options: f.options }));
    }
    for (const raw of project.items.nodes) {
      const singleSelect = {};
      for (const fv of raw.fieldValues.nodes) {
        if (fv.optionId && fv.field?.id) singleSelect[fv.field.id] = fv.optionId;
      }
      const { content, draftTitle } = toContent(raw);
      items.push({ id: raw.id, content, draftTitle, singleSelect });
    }
    if (!project.items.pageInfo.hasNextPage) break;
    cursor = project.items.pageInfo.endCursor;
    if (!cursor) break;
  }
  return { projectId, title, url, fields, items };
}
var SET_FIELD = `
mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
  updateProjectV2ItemFieldValue(input:{
    projectId:$projectId, itemId:$itemId, fieldId:$fieldId,
    value:{ singleSelectOptionId:$optionId }
  }) { projectV2Item { id } }
}`;
var CLEAR_FIELD = `
mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!) {
  clearProjectV2ItemFieldValue(input:{
    projectId:$projectId, itemId:$itemId, fieldId:$fieldId
  }) { projectV2Item { id } }
}`;
async function setSingleSelect(config, projectId, itemId, fieldId, optionId) {
  if (optionId === null) {
    await graphql(config.token, CLEAR_FIELD, { projectId, itemId, fieldId });
    return;
  }
  await graphql(config.token, SET_FIELD, { projectId, itemId, fieldId, optionId });
}

// src/backend/cache.ts
var store = /* @__PURE__ */ new Map();
var TTL_MS = 2e4;
function get(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    store.delete(key);
    return null;
  }
  return hit.value;
}
function set(key, value, ttl = TTL_MS) {
  store.set(key, { value, expires: Date.now() + ttl });
}
function invalidate(key) {
  store.delete(key);
}

// src/frontend/types.ts
var STATUS_FIELD = "Status";
var PRIORITY_FIELD = "Priority";
var SIZE_FIELD = "Size";
function fieldByName(fields, name) {
  const lowered = name.toLowerCase();
  return fields.find((f) => f.name.toLowerCase() === lowered) ?? null;
}

// src/backend/server.ts
function installSkill() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (!home) return;
    const source = import_path2.default.join(__dirname, "..", "skill", "SKILL.md");
    if (!import_fs2.default.existsSync(source)) return;
    const wanted = import_fs2.default.readFileSync(source, "utf8");
    const target = import_path2.default.join(home, ".claude", "skills", "board", "SKILL.md");
    const current = import_fs2.default.existsSync(target) ? import_fs2.default.readFileSync(target, "utf8") : null;
    if (current === wanted) return;
    import_fs2.default.mkdirSync(import_path2.default.dirname(target), { recursive: true });
    import_fs2.default.writeFileSync(target, wanted, "utf8");
    log(current === null ? "installed /board skill" : "updated /board skill");
  } catch (e) {
    log(`could not install skill: ${e.message}`);
  }
}
function log(msg) {
  process.stderr.write(`[cadence-project-board] ${msg}
`);
}
function query(req) {
  const out = {};
  try {
    new import_url.URL(req.url ?? "", "http://localhost").searchParams.forEach((v, k) => {
      out[k] = v;
    });
  } catch {
  }
  return out;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(json);
}
function sendError(res, e) {
  if (e instanceof NotConfiguredError) {
    sendJson(res, 200, { notConfigured: true, error: e.message });
    return;
  }
  if (e instanceof GitHubError) {
    sendJson(res, 200, { error: e.message, status: e.status ?? null });
    return;
  }
  const msg = e instanceof Error ? e.message : String(e);
  log(`unhandled: ${msg}`);
  sendJson(res, 500, { error: msg });
}
async function handleGetConfig(req, res) {
  const projectPath = query(req)["path"] ?? "";
  if (!projectPath) return sendJson(res, 200, { notConfigured: true, error: "No project is open." });
  sendJson(res, 200, await publicConfig(projectPath));
}
async function handlePostConfig(req, res) {
  const projectPath = query(req)["path"] ?? "";
  if (!projectPath) return sendJson(res, 400, { error: "No project is open." });
  const body = JSON.parse(await readBody(req));
  const { gitignored } = await writeConfig(projectPath, body);
  invalidate(projectPath);
  sendJson(res, 200, { ok: true, gitignored });
}
async function handleGetBoard(req, res) {
  const projectPath = query(req)["path"] ?? "";
  const fresh = query(req)["fresh"] === "1";
  if (!projectPath) return sendJson(res, 200, { notConfigured: true, error: "No project is open." });
  const config = await readConfig(projectPath);
  if (!config.enabled) {
    return sendJson(res, 200, { notConfigured: true, error: "The board is turned off for this project." });
  }
  if (!fresh) {
    const hit = get(projectPath);
    if (hit) return sendJson(res, 200, hit);
  }
  const board = await fetchBoard(config);
  set(projectPath, board);
  sendJson(res, 200, board);
}
var WRITABLE = [STATUS_FIELD, PRIORITY_FIELD, SIZE_FIELD];
async function handleSetField(req, res) {
  const projectPath = query(req)["path"] ?? "";
  if (!projectPath) return sendJson(res, 400, { error: "No project is open." });
  const body = JSON.parse(await readBody(req));
  if (!body.itemId) return sendJson(res, 400, { error: "itemId is required." });
  if (!body.field) return sendJson(res, 400, { error: "field is required." });
  const fieldName = WRITABLE.find((f) => f.toLowerCase() === body.field.toLowerCase());
  if (!fieldName) {
    return sendJson(res, 400, { error: `"${body.field}" is not an editable field. Try: ${WRITABLE.join(", ")}.` });
  }
  const config = await readConfig(projectPath);
  const board = await fetchBoard(config);
  set(projectPath, board);
  const field = fieldByName(board.fields, fieldName);
  if (!field) {
    return sendJson(res, 200, { error: `This project has no "${fieldName}" field.` });
  }
  let optionId = null;
  if (body.option) {
    const wanted = body.option.trim().toLowerCase();
    const match = field.options.find((o) => o.name.toLowerCase() === wanted || o.id === body.option);
    if (!match) {
      const names = field.options.map((o) => o.name).join(", ");
      return sendJson(res, 200, { error: `"${body.option}" is not a ${fieldName}. Try: ${names}.` });
    }
    optionId = match.id;
  }
  await setSingleSelect(config, board.projectId, body.itemId, field.id, optionId);
  invalidate(projectPath);
  sendJson(res, 200, { ok: true });
}
var server = import_http.default.createServer((req, res) => {
  const method = req.method ?? "GET";
  const pathname = (() => {
    try {
      return new import_url.URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      return "/";
    }
  })();
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }
  const route = async () => {
    if (method === "GET" && pathname === "/config") return handleGetConfig(req, res);
    if (method === "POST" && pathname === "/config") return handlePostConfig(req, res);
    if (method === "GET" && pathname === "/board") return handleGetBoard(req, res);
    if (method === "POST" && pathname === "/field") return handleSetField(req, res);
    if (method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true });
    sendJson(res, 404, { error: `No route for ${method} ${pathname}` });
  };
  route().catch((e) => sendError(res, e));
});
installSkill();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  process.stdout.write(JSON.stringify({ ready: true, port }) + "\n");
  log(`listening on 127.0.0.1:${port}`);
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
