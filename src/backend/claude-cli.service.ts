import { spawn } from 'child_process';
import os from 'os';

/**
 * Asking the Claude Code CLI instead of the Anthropic API.
 *
 * ## Why this exists
 *
 * AI Prioritize originally needed its own `ANTHROPIC_API_KEY`, which is a second
 * credential and a second bill for a reader who is *already* signed in to Claude — they
 * are running this plugin inside claudecodeui, which is Claude Code. Asking them to
 * paste an API key beside a working Claude login is asking them to pay twice for the
 * same thing.
 *
 * Three facts make the local CLI reachable from a plugin subprocess, and all three had
 * to hold:
 *
 * 1. **`HOME` is passed through.** claudecodeui strips a plugin's environment down to
 *    `PATH`, `HOME`, `NODE_ENV` and `PLUGIN_NAME` — which kills env-var credentials
 *    (see `config.service`) but leaves *file*-based ones intact. Claude Code's
 *    credential lives at `~/.claude/.credentials.json`.
 * 2. **`PATH` is passed through**, and the host's own PATH includes the directory the
 *    `claude` binary is installed in.
 * 3. **`claude -p` runs headlessly** against that credential, subscription or API key
 *    alike, and `--output-format json` gives a machine-readable envelope.
 *
 * ## Why it is not simply preferred over an explicit key
 *
 * An `anthropicKey` in the config file still wins. Explicit configuration beats an
 * ambient credential — the same precedence the GitHub token already follows — because a
 * reader who deliberately pasted a key meant to use it, and silently routing around it
 * would bill the wrong account.
 */

/** Long enough for a real board with adaptive thinking; short enough to give up on. */
const TIMEOUT_MS = 180_000;

let cached: boolean | null = null;

/**
 * Whether the `claude` binary can be run at all.
 *
 * Probed by actually executing `claude --version` rather than by looking for the file:
 * `PATH` inside the plugin subprocess is not the shell's, the binary may be a wrapper
 * script that fails on its own, and "is on disk" is not the question anyone cares about.
 * Cached for the process's life — a CLI does not appear mid-session, and this is checked
 * on every board render.
 */
export function isAvailable(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdio: ['ignore', 'ignore', 'ignore']
    });
    const done = (ok: boolean) => {
      cached = ok;
      resolve(ok);
    };
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
    setTimeout(() => {
      child.kill();
      done(false);
    }, 10_000).unref();
  });
}

export class ClaudeCliError extends Error {}

/**
 * One headless turn, prompt in on **stdin**.
 *
 * stdin rather than argv because the prompt carries every issue's title, labels and a
 * body excerpt — a couple of hundred kilobytes on a large board, which is the kind of
 * thing that works in testing and then fails on somebody's real backlog when it crosses
 * the argument-length limit.
 *
 * `cwd` is the system temp directory on purpose. Claude Code reads project context from
 * the directory it is started in — `CLAUDE.md`, the file tree — and none of that belongs
 * in a triage prompt. An empty directory also means there is nothing for it to reach for
 * if it decides the task looks like a coding job.
 *
 * The child's environment is `PATH` and `HOME` and nothing else: `HOME` is what makes the
 * credential findable, `PATH` is what makes the binary findable, and anything more is
 * this plugin's business rather than the CLI's.
 */
export function ask(model: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json', '--model', model], {
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let out = '';
    let err = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new ClaudeCliError(`Claude took longer than ${TIMEOUT_MS / 1000}s.`)));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });

    child.on('error', (e) =>
      finish(() => reject(new ClaudeCliError(`Could not run the claude CLI: ${e.message}`)))
    );

    child.on('close', (code) =>
      finish(() => {
        if (code !== 0) {
          return reject(new ClaudeCliError(err.trim().slice(0, 300) || `claude exited ${code}.`));
        }
        let envelope: { is_error?: boolean; result?: string };
        try {
          envelope = JSON.parse(out);
        } catch {
          return reject(new ClaudeCliError('claude returned output that was not JSON.'));
        }
        // `is_error` is the CLI's own flag; a turn can fail while still exiting 0, so
        // the exit code alone is not the check.
        if (envelope.is_error || typeof envelope.result !== 'string') {
          return reject(new ClaudeCliError(envelope.result?.slice(0, 300) || 'claude reported an error.'));
        }
        resolve(envelope.result);
      })
    );

    child.stdin.on('error', () => {
      /* the child died before the prompt finished writing; `close` reports the reason */
    });
    child.stdin.end(prompt);
  });
}

/**
 * The JSON object inside a possibly chatty reply.
 *
 * The API path can constrain the response with a schema; the CLI cannot, so the reply may
 * arrive fenced, prefaced, or followed by a sentence however firmly the prompt asks for
 * bare JSON. Slicing from the first `{` to the last `}` survives all three, and anything
 * it cannot parse falls through to the heuristic rather than failing the request — see
 * `prioritize`.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to the brace slice */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) throw new ClaudeCliError('Claude did not return any JSON.');
  return JSON.parse(trimmed.slice(start, end + 1));
}
