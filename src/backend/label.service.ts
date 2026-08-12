import type { ResolvedConfig } from './config.service';
import { GitHubError } from './project.service';

/**
 * Mirroring a project field onto the issue as a label.
 *
 * ## Why mirror rather than move
 *
 * Projects v2 field values are reachable from the issue (`issue.projectItems.fieldValues`)
 * and GitHub renders them in the issue sidebar — but they are **not searchable**. There is
 * no `is:issue priority:P0`; GitHub's issue search cannot query project fields at all. A
 * label can be searched, appears in the issue list, and survives the item being removed
 * from the project.
 *
 * So the field stays canonical and the label follows it. The board keeps its native
 * grouping and this plugin's filter row; the issue gains a value you can search for.
 *
 * ## The label is a mirror, never a source
 *
 * Nothing in this plugin ever reads a label back to decide a field's value. On any
 * disagreement — someone edits the label by hand, a mirror write fails — the field is
 * right and the next write re-syncs the label. Reading labels back would make two
 * sources of truth out of one, and the drift would be silent.
 *
 * ## Namespaced by field name, and that is load-bearing
 *
 * Labels are `priority:P0`, `size:XS` — the field's name lowercased, then the option name.
 * Not the bare option name, for two reasons. A bare `S` or `M` on an issue list means
 * nothing to a reader. And, more seriously, setting a value removes the *sibling* options'
 * labels to keep the choice exclusive — with bare names that removal could delete a
 * pre-existing label of somebody's that happens to be called `M`. The prefix makes every
 * label this file touches unmistakably ours.
 *
 * It also generalises: a project whose field is `Severity` gets `severity:High`, with no
 * code change and nothing hardcoded to `Priority`/`Size`.
 */

const REST = 'https://api.github.com';

/** GitHub label colours are 6 hex digits, no `#`. */
const COLOURS: Record<string, string> = {
  // Priority — a red-amber-grey ramp, most urgent first.
  p0: 'b60205',
  p1: 'd93f0b',
  p2: 'fbca04',
  // Size — a single neutral ramp, so size never competes with priority for attention.
  xs: 'ededed',
  s: 'd4d4d4',
  m: 'bfbfbf',
  l: 'a8a8a8',
  xl: '8f8f8f'
};
const DEFAULT_COLOUR = 'c5def5';

/** `Priority` + `P0` → `priority:P0`. */
export function labelNameFor(fieldName: string, optionName: string): string {
  return `${fieldName.toLowerCase()}:${optionName}`;
}

interface RepoRef {
  owner: string;
  repo: string;
}

/** `edgeroute/cadence` → `{owner, repo}`. */
export function parseRepo(nameWithOwner: string): RepoRef | null {
  const [owner, repo] = nameWithOwner.split('/');
  return owner && repo ? { owner, repo } : null;
}

async function rest(
  config: ResolvedConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${REST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).catch((e: Error) => {
    throw new GitHubError(`Could not reach GitHub: ${e.message}`);
  });

  // 204 (no content) and 404 are both normal here — see the callers.
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * Create the label if the repository does not have it yet.
 *
 * A 422 is treated as success, not as an error: it is what GitHub returns when the label
 * already exists, and two cards being triaged at once will race to create the same one.
 * Losing that race is the expected outcome, not a failure.
 */
async function ensureLabel(config: ResolvedConfig, ref: RepoRef, name: string, optionName: string): Promise<void> {
  const path = `/repos/${ref.owner}/${ref.repo}/labels`;
  const existing = await rest(config, 'GET', `${path}/${encodeURIComponent(name)}`);
  if (existing.status === 200) return;
  if (existing.status !== 404) {
    throw new GitHubError(`Could not check for the "${name}" label (${existing.status}).`, existing.status);
  }

  const created = await rest(config, 'POST', path, {
    name,
    color: COLOURS[optionName.toLowerCase()] ?? DEFAULT_COLOUR,
    description: 'Mirrors this issue’s project field. Managed by the Project Board plugin.'
  });
  if (created.status === 201 || created.status === 422) return;
  throw new GitHubError(`Could not create the "${name}" label (${created.status}).`, created.status);
}

/**
 * Put the issue's labels in step with one field's value.
 *
 * Removals run **before** the addition, and every sibling is removed rather than only the
 * one previously set: the field may have been changed on github.com since the last mirror,
 * so "what the label used to be" is not knowable from here. Removing all siblings makes
 * the result correct from any starting state rather than only from the one we last wrote.
 *
 * A 404 on a removal means the issue did not carry that label — the ordinary case, and
 * not an error.
 *
 * `optionName` of `null` clears the field, so every sibling is removed and nothing added.
 */
export async function mirrorFieldToLabels(
  config: ResolvedConfig,
  repository: string,
  issueNumber: number,
  fieldName: string,
  optionName: string | null,
  allOptionNames: string[]
): Promise<void> {
  const ref = parseRepo(repository);
  if (!ref) return;

  const wanted = optionName ? labelNameFor(fieldName, optionName) : null;
  const siblings = allOptionNames
    .map((o) => labelNameFor(fieldName, o))
    .filter((n) => n !== wanted);

  for (const name of siblings) {
    const res = await rest(
      config,
      'DELETE',
      `/repos/${ref.owner}/${ref.repo}/issues/${issueNumber}/labels/${encodeURIComponent(name)}`
    );
    if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
      throw new GitHubError(`Could not remove the "${name}" label (${res.status}).`, res.status);
    }
  }

  if (!wanted) return;

  await ensureLabel(config, ref, wanted, optionName!);
  const added = await rest(config, 'POST', `/repos/${ref.owner}/${ref.repo}/issues/${issueNumber}/labels`, {
    labels: [wanted]
  });
  if (added.status !== 200 && added.status !== 201) {
    throw new GitHubError(`Could not add the "${wanted}" label (${added.status}).`, added.status);
  }
}
