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
import type { ProjectField } from '../frontend/types';

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

/**
 * Stamp a freshly-read board with the moment it was read.
 *
 * Applied at every point a board enters the cache, so the stamp survives being served from
 * it — which is the only reason it exists. See `BoardData.fetchedAt`.
 */
function stamp(board: Awaited<ReturnType<typeof projectService.fetchBoard>>) {
  return { ...board, fetchedAt: Date.now() };
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
  cache.set(projectPath, stamp(board));
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
/** One requested change, as it arrives from the board, the modal, or the skill. */
interface FieldWrite {
  itemId?: string;
  field?: string;
  option?: string | null;
}

/** What became of one requested change. */
interface WriteOutcome {
  itemId: string;
  field: string;
  ok: boolean;
  error?: string;
  warning?: string;
}

/**
 * Apply a set of changes against **one** board snapshot.
 *
 * The snapshot is the point. Every write needs the same three things — the project id,
 * the field's id, and the option's id — and none of them can change while a batch is in
 * flight, so fetching the board once and reusing it is exactly as correct as fetching it
 * per write and around a second cheaper each time.
 *
 * Writes run in series rather than concurrently. GitHub's secondary rate limits treat
 * parallel mutations from one token as abuse, and a batch that trips them fails halfway
 * through with some issues written and some not — a worse outcome than taking longer.
 */
async function applyWrites(
  projectPath: string,
  writes: FieldWrite[]
): Promise<{ outcomes: WriteOutcome[] } | { error: string; status: number }> {
  const config = await configService.readConfig(projectPath);
  // Straight from GitHub rather than from cache: this resolves the ids the mutations are
  // about to be issued against, and a stale option id fails in a way that reads like the
  // board is broken rather than out of date.
  const board = await projectService.fetchBoard(config);
  cache.set(projectPath, stamp(board));

  // ---- resolve every write against the snapshot before anything is sent -------------
  const outcomes: WriteOutcome[] = [];
  const resolved: { outcomeIndex: number; itemId: string; field: ProjectField; optionId: string | null }[] = [];

  for (const write of writes) {
    if (!write.itemId) return { error: 'itemId is required.', status: 400 };
    if (!write.field) return { error: 'field is required.', status: 400 };

    const fieldName = WRITABLE.find((f) => f.toLowerCase() === write.field!.toLowerCase());
    if (!fieldName) {
      return { error: `"${write.field}" is not an editable field. Try: ${WRITABLE.join(', ')}.`, status: 400 };
    }

    const outcomeIndex = outcomes.length;
    outcomes.push({ itemId: write.itemId, field: fieldName, ok: true });

    const field = fieldByName(board.fields, fieldName);
    if (!field) {
      outcomes[outcomeIndex] = { itemId: write.itemId, field: fieldName, ok: false, error: `This project has no "${fieldName}" field.` };
      continue;
    }

    let optionId: string | null = null;
    if (write.option) {
      const wanted = write.option.trim().toLowerCase();
      const match = field.options.find((o) => o.name.toLowerCase() === wanted || o.id === write.option);
      if (!match) {
        const names = field.options.map((o) => o.name).join(', ');
        outcomes[outcomeIndex] = { itemId: write.itemId, field: fieldName, ok: false, error: `"${write.option}" is not a ${fieldName}. Try: ${names}.` };
        continue;
      }
      optionId = match.id;
    }

    resolved.push({ outcomeIndex, itemId: write.itemId, field, optionId });
  }

  if (!resolved.length) return { outcomes };

  // ---- the field writes, in one document per twenty ---------------------------------
  const { failures } = await projectService.setManySingleSelect(
    config,
    board.projectId,
    resolved.map((r) => ({ itemId: r.itemId, fieldId: r.field.id, optionId: r.optionId }))
  );

  const landed = resolved.filter((r, i) => {
    const failure = failures.get(i);
    if (failure === undefined) return true;
    outcomes[r.outcomeIndex] = { itemId: r.itemId, field: r.field.name, ok: false, error: failure };
    return false;
  });

  cache.invalidate(projectPath);
  if (!landed.length) return { outcomes };

  /*
    Mirror the values onto the issues as labels — see `label.service`.

    **Grouped by issue, not by write.** An apply sets Priority and Size on the same issue,
    and mirroring each separately meant two round trips to the same endpoint on the same
    issue. Grouping also makes the "what does this issue already carry?" question answerable
    once, from the snapshot, rather than once per field against a view the previous mirror
    has already invalidated.

    **Status is deliberately not mirrored.** Status is the board's own axis: it is what the
    columns *are*, every item has one, and a `status:Backlog` label on every issue in the
    repository would be noise rather than information. Priority and Size are the two a
    reader wants to find from the issue list, and the two that are usually unset.

    **A mirror failure does not fail the write.** The field write already succeeded and is
    the source of truth; answering with an error would tell the reader their change did not
    happen and invite them to repeat a write that did. It comes back as a warning beside
    `ok: true` instead, so the board updates and the reader still learns the label is out
    of step.
  */
  const byItem = new Map<string, typeof landed>();
  for (const r of landed) {
    if (r.field.name === STATUS_FIELD) continue;
    const list = byItem.get(r.itemId);
    if (list) list.push(r);
    else byItem.set(r.itemId, [r]);
  }

  for (const [itemId, writesForItem] of byItem) {
    const content = board.items.find((i) => i.id === itemId)?.content;
    if (!content?.number || !content.repository) continue;

    try {
      await labelService.mirrorIssueLabels(
        config,
        content.repository,
        content.number,
        writesForItem.map((r) => ({
          fieldName: r.field.name,
          optionName: r.optionId ? r.field.options.find((o) => o.id === r.optionId)?.name ?? null : null,
          allOptionNames: r.field.options.map((o) => o.name)
        })),
        // The snapshot's own label list, so only labels actually present are touched.
        (content.labels ?? []).map((l) => l.name)
      );
    } catch (e) {
      const message = `Saved, but the matching label could not be updated: ${(e as Error).message}`;
      for (const r of writesForItem) outcomes[r.outcomeIndex].warning = message;
    }
  }

  return { outcomes };
}

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

  const body = JSON.parse(await readBody(req)) as FieldWrite;
  const result = await applyWrites(projectPath, [body]);
  if ('error' in result) return sendJson(res, result.status, { error: result.error });

  const [outcome] = result.outcomes;
  if (!outcome.ok) return sendJson(res, 200, { error: outcome.error });
  sendJson(res, 200, outcome.warning ? { ok: true, warning: outcome.warning } : { ok: true });
}

/**
 * Apply many changes at once — what Apply in the suggestions panel calls.
 *
 * This exists because the single-write route is the wrong shape for a batch, not because
 * it was wrong. Applying 17 items through it meant 34 requests, each refetching the whole
 * board to resolve ids that were identical every time: around ten seconds per issue, most
 * of it spent re-reading a board that had not changed.
 *
 * One partial write does not abort the rest. A batch that stopped at the first failure
 * would leave the reader with an unknown number of items applied and no way to tell which,
 * so every requested change is attempted and each reports its own outcome.
 */
async function handleSetFields(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const projectPath = query(req)['path'] ?? '';
  if (!projectPath) return sendJson(res, 400, { error: 'No project is open.' });

  const body = JSON.parse(await readBody(req)) as { writes?: FieldWrite[] };
  if (!Array.isArray(body.writes)) return sendJson(res, 400, { error: 'writes must be an array.' });
  if (!body.writes.length) return sendJson(res, 200, { ok: true, outcomes: [] });

  const result = await applyWrites(projectPath, body.writes);
  if ('error' in result) return sendJson(res, result.status, { error: result.error });
  sendJson(res, 200, { ok: true, outcomes: result.outcomes });
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
  cache.set(projectPath, stamp(board));

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

/**
 * Open an issue and put it on the board, optionally in a named column.
 *
 * The board is read fresh rather than from cache, for the reason `applyWrites` gives: this
 * resolves the project id the add is issued against and the Status option id the new row is
 * then set to, and a stale id fails in a way that reads like the plugin is broken rather
 * than out of date.
 *
 * **A failed Status write does not fail the request.** The issue is open and on the board
 * by the time it is attempted; reporting the whole thing as a failure would send the reader
 * to write it again, and they would end up with two. It comes back as a `warning` beside an
 * `ok`, which is the same shape `handleSetField` already uses when the field lands and the
 * label mirror does not.
 */
async function handleCreateIssue(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const projectPath = query(req)['path'] ?? '';
  if (!projectPath) return sendJson(res, 400, { error: 'No project is open.' });

  const body = JSON.parse(await readBody(req)) as {
    repository?: string;
    title?: string;
    body?: string;
    status?: string | null;
  };

  // Trimmed and checked here rather than trusted from the form. GitHub will accept a
  // whitespace-only title and draw a blank card, which is a thing nobody can find again.
  const title = (body.title ?? '').trim();
  if (!title) return sendJson(res, 200, { error: 'Give the issue a title first.' });
  const repository = (body.repository ?? '').trim();
  if (!repository) return sendJson(res, 200, { error: 'Choose which repository this belongs in.' });

  const config = await configService.readConfig(projectPath);
  const board = await projectService.fetchBoard(config);

  const created = await projectService.createIssue(
    config,
    board.projectId,
    repository,
    title,
    (body.body ?? '').trim() || null
  );

  // The board is a row longer than the cached copy says. Dropped before the Status write,
  // so a throw in there still leaves the next read going to GitHub.
  cache.invalidate(projectPath);

  let warning: string | undefined;
  const wanted = (body.status ?? '').trim();
  if (wanted) {
    const status = fieldByName(board.fields, STATUS_FIELD);
    const option = status?.options.find((o) => o.name.toLowerCase() === wanted.toLowerCase());
    if (!status || !option) {
      warning = `Opened #${created.number}, but there is no "${wanted}" column to put it in.`;
    } else {
      try {
        await projectService.setManySingleSelect(config, board.projectId, [
          { itemId: created.itemId, fieldId: status.id, optionId: option.id }
        ]);
      } catch (e) {
        warning = `Opened #${created.number}, but it could not be moved to ${option.name} — ${(e as Error).message}`;
      }
    }
  }

  sendJson(res, 200, { ok: true, issue: created, warning });
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
    if (method === 'POST' && pathname === '/fields') return handleSetFields(req, res);
    if (method === 'GET' && pathname === '/comments') return handleGetComments(req, res);
    if (method === 'POST' && pathname === '/comments') return handlePostComment(req, res);
    if (method === 'POST' && pathname === '/issues') return handleCreateIssue(req, res);
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
