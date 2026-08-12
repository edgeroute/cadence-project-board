import path from 'path';
import { promises as fs } from 'fs';

const CONFIG_DIR = '.CadenceBoard';
const CONFIG_FILE = path.join(CONFIG_DIR, 'project-board.json');

export interface BoardConfigFile {
  token?: string;
  owner: string;
  projectNumber: number;
  enabled?: boolean;
}

export interface ResolvedConfig {
  token: string;
  owner: string;
  projectNumber: number;
  enabled: boolean;
  tokenSource: 'config' | 'env';
}

export class NotConfiguredError extends Error {
  readonly notConfigured = true;
}

/**
 * The token, from the config file or the environment.
 *
 * `GH_TOKEN` (and `GITHUB_TOKEN`, which is what CI and the `gh` CLI both set) is
 * checked as a fallback so a machine that already has a working credential does not
 * need a second copy of it pasted into a file. The file wins when both exist: it is
 * the one the reader chose deliberately for this project, and a stray shell export
 * should not silently redirect the board to a different account's token.
 *
 * It is deliberately never returned to the frontend — see `publicConfig`.
 */
function envToken(): string | null {
  const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return t && t.trim() ? t.trim() : null;
}

export async function readConfig(projectPath: string): Promise<ResolvedConfig> {
  if (!projectPath) throw new NotConfiguredError('No project is open.');

  let parsed: BoardConfigFile | null = null;
  try {
    const raw = await fs.readFile(path.join(projectPath, CONFIG_FILE), 'utf8');
    parsed = JSON.parse(raw) as BoardConfigFile;
  } catch {
    parsed = null;
  }

  if (!parsed || !parsed.owner || !parsed.projectNumber) {
    throw new NotConfiguredError(
      'This project has no board configured yet. Add the owner and project number in Settings.'
    );
  }

  const fileToken = parsed.token?.trim();
  const token = fileToken || envToken();
  if (!token) {
    throw new NotConfiguredError(
      'No GitHub token. Add one in Settings, or set GH_TOKEN in the environment claudecodeui runs in.'
    );
  }

  return {
    token,
    owner: parsed.owner,
    projectNumber: Number(parsed.projectNumber),
    enabled: parsed.enabled !== false,
    tokenSource: fileToken ? 'config' : 'env'
  };
}

/** What the settings UI is allowed to see. The token itself never crosses the RPC boundary. */
export async function publicConfig(projectPath: string): Promise<{
  owner: string;
  projectNumber: number | null;
  enabled: boolean;
  tokenSource: 'config' | 'env' | 'none';
}> {
  let parsed: BoardConfigFile | null = null;
  try {
    const raw = await fs.readFile(path.join(projectPath, CONFIG_FILE), 'utf8');
    parsed = JSON.parse(raw) as BoardConfigFile;
  } catch {
    parsed = null;
  }
  const tokenSource = parsed?.token?.trim() ? 'config' : envToken() ? 'env' : 'none';
  return {
    owner: parsed?.owner ?? '',
    projectNumber: parsed?.projectNumber ?? null,
    enabled: parsed?.enabled !== false,
    tokenSource
  };
}

/**
 * Writing the config, and keeping it out of git.
 *
 * The `.gitignore` append is not a nicety. This file holds a classic PAT with `repo`
 * scope — every private repository the owner can reach — and it is written into the
 * user's own project directory, which is a git repo by definition in this host. A
 * token committed and pushed is a token to revoke, and the window between writing it
 * and noticing is exactly one `git add -A`.
 *
 * Appended rather than rewritten, and only when the entry is absent, so an existing
 * .gitignore is never reordered or de-duplicated behind the reader's back. A missing
 * .gitignore is created; a failure to write one is swallowed rather than failing the
 * save, because a board that refuses to configure itself over a .gitignore is worse
 * than one that warns — the caller reports `gitignored: false` and the UI says so.
 */
async function ensureGitignored(projectPath: string): Promise<boolean> {
  const gitignore = path.join(projectPath, '.gitignore');
  const entry = `${CONFIG_DIR}/`;
  try {
    let current = '';
    try {
      current = await fs.readFile(gitignore, 'utf8');
    } catch {
      current = '';
    }
    const already = current
      .split('\n')
      .map((l) => l.trim())
      .some((l) => l === entry || l === CONFIG_DIR);
    if (already) return true;
    const prefix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    await fs.appendFile(
      gitignore,
      `${prefix}\n# Project Board plugin — holds a GitHub token\n${entry}\n`,
      'utf8'
    );
    return true;
  } catch {
    return false;
  }
}

export async function writeConfig(
  projectPath: string,
  input: BoardConfigFile
): Promise<{ gitignored: boolean }> {
  if (!projectPath) throw new Error('No project is open.');
  if (!input.owner?.trim()) throw new Error('An owner is required.');
  if (!input.projectNumber) throw new Error('A project number is required.');

  const dir = path.join(projectPath, CONFIG_DIR);
  await fs.mkdir(dir, { recursive: true });

  // Preserve an existing token when the settings form submits a blank one — the form
  // never receives the current token (see `publicConfig`), so an empty field means
  // "leave it alone", not "clear it". Without this, saving a changed project number
  // would silently delete the credential.
  let existing: BoardConfigFile | null = null;
  try {
    existing = JSON.parse(await fs.readFile(path.join(projectPath, CONFIG_FILE), 'utf8'));
  } catch {
    existing = null;
  }

  const token = input.token?.trim() || existing?.token || undefined;
  const body: BoardConfigFile = {
    owner: input.owner.trim(),
    projectNumber: Number(input.projectNumber),
    enabled: input.enabled !== false
  };
  if (token) body.token = token;

  const gitignored = await ensureGitignored(projectPath);
  await fs.writeFile(path.join(projectPath, CONFIG_FILE), JSON.stringify(body, null, 2) + '\n', {
    encoding: 'utf8',
    // 0600: the file holds a token and lives in a directory the reader may well share
    // over a network mount. Node applies this only on create, which is the case that
    // matters — an existing file keeps whatever the reader set.
    mode: 0o600
  });
  return { gitignored };
}
