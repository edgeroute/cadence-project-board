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
 * Labels this process has already established exist, as `owner/repo#label`.
 *
 * A label that exists does not stop existing, so the check is worth doing once rather
 * than once per issue. On a 17-item apply that is the difference between 34 existence
 * probes and two.
 */
const known = new Set<string>();

/**
 * Create the label if the repository does not have it yet.
 *
 * A 422 is treated as success, not as an error: it is what GitHub returns when the label
 * already exists, and two cards being triaged at once will race to create the same one.
 * Losing that race is the expected outcome, not a failure.
 */
async function ensureLabel(config: ResolvedConfig, ref: RepoRef, name: string, optionName: string): Promise<void> {
  const memo = `${ref.owner}/${ref.repo}#${name}`;
  if (known.has(memo)) return;

  const path = `/repos/${ref.owner}/${ref.repo}/labels`;
  const existing = await rest(config, 'GET', `${path}/${encodeURIComponent(name)}`);
  if (existing.status === 200) {
    known.add(memo);
    return;
  }
  if (existing.status !== 404) {
    throw new GitHubError(`Could not check for the "${name}" label (${existing.status}).`, existing.status);
  }

  const created = await rest(config, 'POST', path, {
    name,
    color: COLOURS[optionName.toLowerCase()] ?? DEFAULT_COLOUR,
    description: 'Mirrors this issue’s project field. Managed by the Project Board plugin.'
  });
  if (created.status === 201 || created.status === 422) {
    known.add(memo);
    return;
  }
  throw new GitHubError(`Could not create the "${name}" label (${created.status}).`, created.status);
}

/** One field's new value on one issue, for `mirrorIssueLabels`. */
export interface FieldMirror {
  fieldName: string;
  optionName: string | null;
  allOptionNames: string[];
}

/**
 * Put one issue's labels in step with its fields — all of them, in one pass.
 *
 * Takes every field at once rather than one per call, because an apply sets Priority and
 * Size on the same issue and mirroring them separately meant two `POST .../labels` calls
 * to the same endpoint on the same issue. `POST` accepts an array and is purely additive,
 * so combining them is strictly fewer round trips with no change in what happens.
 *
 * **Only what is actually present is removed.** `currentLabels` is the issue's label list
 * from the same board snapshot that resolved the field ids — GitHub's own answer from
 * moments earlier — so the siblings to delete are known rather than guessed. Omit it and
 * every sibling is deleted blind, which is correct from any starting state but costs a
 * round trip per option whatever the issue actually carries. Across a 17-item apply that
 * blind path was most of the wall clock.
 *
 * A 404 on a removal means the issue did not carry that label — expected on the blind
 * path, and not an error.
 *
 * An `optionName` of `null` clears that field: its siblings go and nothing replaces them.
 *
 * Deliberately **not** `PUT .../labels`, which would do the whole job — removals and
 * additions — in a single call. `PUT` replaces the issue's entire label set, so it would
 * silently drop any label added on github.com between our board snapshot and this write.
 * Trading someone else's label for a few hundred milliseconds is not a trade worth making.
 */
export async function mirrorIssueLabels(
  config: ResolvedConfig,
  repository: string,
  issueNumber: number,
  fields: FieldMirror[],
  currentLabels?: string[]
): Promise<void> {
  const ref = parseRepo(repository);
  if (!ref) return;

  const present = currentLabels ? new Set(currentLabels) : null;
  const remove: string[] = [];
  const add: { name: string; optionName: string }[] = [];

  for (const f of fields) {
    const wanted = f.optionName ? labelNameFor(f.fieldName, f.optionName) : null;
    for (const sibling of f.allOptionNames.map((o) => labelNameFor(f.fieldName, o))) {
      if (sibling !== wanted && (!present || present.has(sibling))) remove.push(sibling);
    }
    if (wanted && !present?.has(wanted)) add.push({ name: wanted, optionName: f.optionName! });
  }

  for (const name of remove) {
    const res = await rest(
      config,
      'DELETE',
      `/repos/${ref.owner}/${ref.repo}/issues/${issueNumber}/labels/${encodeURIComponent(name)}`
    );
    if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
      throw new GitHubError(`Could not remove the "${name}" label (${res.status}).`, res.status);
    }
  }

  if (!add.length) return;

  for (const a of add) await ensureLabel(config, ref, a.name, a.optionName);
  const added = await rest(config, 'POST', `/repos/${ref.owner}/${ref.repo}/issues/${issueNumber}/labels`, {
    labels: add.map((a) => a.name)
  });
  if (added.status !== 200 && added.status !== 201) {
    throw new GitHubError(`Could not add ${add.map((a) => `"${a.name}"`).join(' and ')} (${added.status}).`, added.status);
  }
}
