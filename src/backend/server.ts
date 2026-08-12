import http from 'http';
import path from 'path';
import fs from 'fs';
import { URL } from 'url';
import * as configService from './config.service';
import { NotConfiguredError } from './config.service';
import * as projectService from './project.service';
import { GitHubError } from './project.service';
import * as cache from './cache';
import * as labelService from './label.service';
import * as aiService from './ai.service';
import { fieldByName, STATUS_FIELD, PRIORITY_FIELD, SIZE_FIELD } from '../frontend/types';

/**
 * Copy the companion skill into the reader's Claude Code skills directory.
 *
 * Refreshed whenever the content differs rather than only when the file is missing.
 * The reference plugin installed once and hit exactly the bug that implies: an old
 * installed skill shadowed every later version of the plugin, silently, because the
 * only condition it checked was existence.
 *
 * Every failure here is swallowed. A skill is a convenience; the board is the product,
 * and a read-only home directory must not stop the tab from loading.
 */
function installSkill(): void {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (!home) return;
    // `__dirname` is dist/ in the CJS bundle, so the source sits one level up.
    const source = path.join(__dirname, '..', 'skill', 'SKILL.md');
    if (!fs.existsSync(source)) return;
    const wanted = fs.readFileSync(source, 'utf8');
    const target = path.join(home, '.claude', 'skills', 'board', 'SKILL.md');
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === wanted) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, wanted, 'utf8');
    log(current === null ? 'installed /board skill' : 'updated /board skill');
  } catch (e) {
    log(`could not install skill: ${(e as Error).message}`);
  }
}

function log(msg: string): void {
  // stdout carries the ready handshake, so everything else goes to stderr. A stray
  // log line on stdout before the handshake is parsed as the handshake and fails it.
  process.stderr.write(`[cadence-project-board] ${msg}\n`);
}

function query(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    new URL(req.url ?? '', 'http://localhost').searchParams.forEach((v, k) => {
      out[k] = v;
    });
  } catch {
    /* fall through to an empty query, which every handler treats as a missing path */
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(json);
}

/**
 * The one place an error becomes a response.
 *
 * `NotConfiguredError` answers **200**, not 4xx, and that is deliberate: "you have not
 * set this up yet" is a state the board renders a setup panel for, not a failure. The
 * reference plugin does the same, and the alternative is a frontend that has to treat
 * one particular error status as success.
 */
function sendError(res: http.ServerResponse, e: unknown): void {
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

async function handleGetConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const projectPath = query(req)['path'] ?? '';
  if (!projectPath) return sendJson(res, 200, { notConfigured: true, error: 'No project is open.' });
  sendJson(res, 200, await configService.publicConfig(projectPath));
}

async function handlePostConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const projectPath = query(req)['path'] ?? '';
  if (!projectPath) return sendJson(res, 400, { error: 'No project is open.' });
  const body = JSON.parse(await readBody(req)) as configService.BoardConfigFile;
  const { gitignored } = await configService.writeConfig(projectPath, body);
  cache.invalidate(projectPath);
  sendJson(res, 200, { ok: true, gitignored });
}

async function handleGetBoard(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const projectPath = query(req)['path'] ?? '';
  const fresh = query(req)['fresh'] === '1';
  if (!projectPath) return sendJson(res, 200, { notConfigured: true, error: 'No project is open.' });

  const config = await configService.readConfig(projectPath);
  if (!config.enabled) {
    return sendJson(res, 200, { notConfigured: true, error: 'The board is turned off for this project.' });
  }

  if (!fresh) {
    const hit = cache.get(projectPath);
    if (hit) return sendJson(res, 200, hit);
  }

  const board = await projectService.fetchBoard(config);
  cache.set(projectPath, board);
  sendJson(res, 200, board);
}

/** The fields a card may write, by name. Anything else is refused rather than passed through. */
const WRITABLE = [STATUS_FIELD, PRIORITY_FIELD, SIZE_FIELD];

/**
 * Move a card, or set its Priority or Size.
 *
 * The request names the field and the option by **name**, and this resolves both to
 * ids against the live board. That is a round trip the frontend could have saved by
 * sending ids it already holds — and it is worth paying, because it is what keeps the
 * skill and the board honest to the same board: `/board move 216 ready` says "ready",
 * not `61e4505c`, and both paths land in this one resolution.
 *
 * A null/empty `option` clears the field, which is how a card returns to "No Status".
 */
async function handleSetField(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const projectPath = query(req)['path'] ?? '';
  if (!projectPath) return sendJson(res, 400, { error: 'No project is open.' });

  const body = JSON.parse(await readBody(req)) as {
    itemId?: string;
    field?: string;
    option?: string | null;
  };
  if (!body.itemId) return sendJson(res, 400, { error: 'itemId is required.' });
  if (!body.field) return sendJson(res, 400, { error: 'field is required.' });

  const fieldName = WRITABLE.find((f) => f.toLowerCase() === body.field!.toLowerCase());
  if (!fieldName) {
    return sendJson(res, 400, { error: `"${body.field}" is not an editable field. Try: ${WRITABLE.join(', ')}.` });
  }

  const config = await configService.readConfig(projectPath);
  // Straight from GitHub rather than from cache: this resolves the ids a mutation is
  // about to be issued against, and a stale option id fails in a way that reads like
  // the board is broken rather than out of date.
  const board = await projectService.fetchBoard(config);
  cache.set(projectPath, board);

  const field = fieldByName(board.fields, fieldName);
  if (!field) {
    return sendJson(res, 200, { error: `This project has no "${fieldName}" field.` });
  }

  let optionId: string | null = null;
  if (body.option) {
    const wanted = body.option.trim().toLowerCase();
    const match = field.options.find((o) => o.name.toLowerCase() === wanted || o.id === body.option);
    if (!match) {
      const names = field.options.map((o) => o.name).join(', ');
      return sendJson(res, 200, { error: `"${body.option}" is not a ${fieldName}. Try: ${names}.` });
    }
    optionId = match.id;
  }

  await projectService.setSingleSelect(config, board.projectId, body.itemId, field.id, optionId);
  cache.invalidate(projectPath);

  /*
    Mirror the value onto the issue as a label — see `label.service`.

    **Status is deliberately not mirrored.** Status is the board's own axis: it is what
    the columns *are*, every item has one, and a `status:Backlog` label on every issue in
    the repository would be noise rather than information. Priority and Size are the two
    that a reader wants to find from the issue list, and the two that are usually unset.

    **A mirror failure does not fail the request.** The field write above already
    succeeded and is the source of truth; answering with an error would tell the reader
    their change did not happen and invite them to repeat a write that did. It comes back
    as a warning beside `ok: true` instead, so the board updates and the reader still
    learns the label is out of step.
  */
  let warning: string | undefined;
  if (fieldName !== STATUS_FIELD) {
    const item = board.items.find((i) => i.id === body.itemId);
    const content = item?.content;
    if (content?.number && content.repository) {
      const optionName = optionId ? field.options.find((o) => o.id === optionId)?.name ?? null : null;
      try {
        await labelService.mirrorFieldToLabels(
          config,
          content.repository,
          content.number,
          field.name,
          optionName,
          field.options.map((o) => o.name)
        );
      } catch (e) {
        warning = `Saved, but the matching label could not be updated: ${(e as Error).message}`;
      }
    }
  }

  sendJson(res, 200, warning ? { ok: true, warning } : { ok: true });
}

/**
 * Suggest a Priority and a Size for everything on the board.
 *
 * Suggests only — nothing here writes. The reader reviews the list and applies what they
 * accept through `/field`, one item at a time, which is also what keeps the label mirror
 * and the optimistic UI on a single path. See `ai.service`.
 */
async function handlePrioritize(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const projectPath = query(req)['path'] ?? '';
  if (!projectPath) return sendJson(res, 400, { error: 'No project is open.' });

  const config = await configService.readConfig(projectPath);
  const board = await projectService.fetchBoard(config);
  cache.set(projectPath, board);

  // Only what the reader is looking at. The frontend posts the filtered, searched set of
  // item ids, so triaging "everything in Backlog" costs one Backlog-sized request rather
  // than sending the whole board and discarding most of the answer.
  const body = JSON.parse((await readBody(req)) || '{}') as { itemIds?: string[] };
  const wanted = new Set(body.itemIds ?? []);
  const items = wanted.size ? board.items.filter((i) => wanted.has(i.id)) : board.items;

  sendJson(res, 200, await aiService.prioritize(board, items, config.anthropicKey ?? null, config.aiModel));
}

async function handleGetComments(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const q = query(req);
  const projectPath = q['path'] ?? '';
  const issueId = q['issueId'] ?? '';
  if (!projectPath) return sendJson(res, 400, { error: 'No project is open.' });
  if (!issueId) return sendJson(res, 400, { error: 'issueId is required.' });

  const config = await configService.readConfig(projectPath);
  // Uncached on purpose. A thread is the one thing on this screen that someone else is
  // actively changing while it is open, and a 20-second-old copy of a conversation is
  // worse than a slightly slower one.
  sendJson(res, 200, await projectService.fetchComments(config, issueId));
}

async function handlePostComment(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const projectPath = query(req)['path'] ?? '';
  if (!projectPath) return sendJson(res, 400, { error: 'No project is open.' });

  const body = JSON.parse(await readBody(req)) as { issueId?: string; body?: string };
  if (!body.issueId) return sendJson(res, 400, { error: 'issueId is required.' });

  // Trimmed and checked here rather than trusted from the form: GitHub accepts a
  // whitespace-only comment perfectly happily, and an empty bubble in a thread is a
  // thing nobody can explain afterwards or delete from here.
  const text = (body.body ?? '').trim();
  if (!text) return sendJson(res, 200, { error: 'Write something first.' });

  const config = await configService.readConfig(projectPath);
  const comment = await projectService.addComment(config, body.issueId, text);
  // The board carries a comment count on every card, and it is now one behind.
  cache.invalidate(projectPath);
  sendJson(res, 200, { ok: true, comment });
}

const server = http.createServer((req, res) => {
  const method = req.method ?? 'GET';
  const pathname = (() => {
    try {
      return new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      return '/';
    }
  })();

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const route = async (): Promise<void> => {
    if (method === 'GET' && pathname === '/config') return handleGetConfig(req, res);
    if (method === 'POST' && pathname === '/config') return handlePostConfig(req, res);
    if (method === 'GET' && pathname === '/board') return handleGetBoard(req, res);
    if (method === 'POST' && pathname === '/field') return handleSetField(req, res);
    if (method === 'GET' && pathname === '/comments') return handleGetComments(req, res);
    if (method === 'POST' && pathname === '/comments') return handlePostComment(req, res);
    if (method === 'POST' && pathname === '/prioritize') return handlePrioritize(req, res);
    if (method === 'GET' && pathname === '/health') return sendJson(res, 200, { ok: true });
    sendJson(res, 404, { error: `No route for ${method} ${pathname}` });
  };

  route().catch((e) => sendError(res, e));
});

installSkill();

/**
 * Port 0 — the OS picks a free one and we report it back.
 *
 * The host reads `{"ready":true,"port":N}` from stdout and gives up after 10 seconds,
 * so this is the last thing that happens at startup and nothing above it may block.
 * `installSkill` is synchronous and file-local, which is why it can run before this;
 * anything slower belongs after the handshake.
 */
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.stdout.write(JSON.stringify({ ready: true, port }) + '\n');
  log(`listening on 127.0.0.1:${port}`);
});

/*
  Shut down promptly, which `server.close()` alone does not do.

  `close()` stops accepting new connections and then waits for the open ones to finish —
  and the frontend's `fetch` keeps a keep-alive socket open, so the callback may never
  fire and the process sits there until the host's force-kill timer expires five seconds
  later. `closeIdleConnections()` drops exactly those sockets.

  This matters because of how claudecodeui updates a plugin: it stops the server, pulls,
  and then starts it again — but *only if it was running when the update began*. A slow
  or wedged shutdown is therefore not a cosmetic delay; it is time spent in a state where
  anything that goes wrong leaves the server stopped, and a stopped server is one an
  Update will silently decline to restart.

  Guarded because `closeIdleConnections` arrived in Node 18.2; on anything older this is
  the old behaviour, unchanged.
*/
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    // A last-resort ceiling, well inside the host's own 5s force-kill.
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
