import type { BoardData, ProjectField, ProjectItem, ItemContent } from '../frontend/types';
import type { ResolvedConfig } from './config.service';

const GRAPHQL = 'https://api.github.com/graphql';
const REST = 'https://api.github.com';

/** GitHub caps `first:` at 100 for these connections. */
const PAGE_SIZE = 100;
/** 100 items a page against a 1000-item ceiling — a runaway-pagination backstop, not a real limit. */
const MAX_PAGES = 10;

export class GitHubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; type?: string }>;
}

/**
 * One GraphQL round trip.
 *
 * GraphQL answers 200 with an `errors` array far more often than it answers a non-2xx
 * status, so a bare `res.ok` check reports success on a query that returned nothing.
 * Both are folded into one thrown `GitHubError` here so every caller has exactly one
 * failure shape to handle.
 *
 * `INSUFFICIENT_SCOPES` is singled out because it is the error a reader is most likely
 * to hit and least likely to diagnose: a fine-grained token, or a classic one without
 * `project`, fails on every field of the query at once and the raw message is a wall
 * of near-identical sentences. See the README on why fine-grained cannot work here.
 */
async function graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json'
      },
      body: JSON.stringify({ query, variables })
    });
  } catch (e) {
    throw new GitHubError(`Could not reach GitHub: ${(e as Error).message}`);
  }

  if (res.status === 401) throw new GitHubError('GitHub rejected the token (401). Check it in Settings.', 401);

  const json = (await res.json().catch(() => null)) as GraphQLResponse<T> | null;
  if (!json) throw new GitHubError(`GitHub returned an unreadable response (${res.status}).`, res.status);

  if (json.errors?.length) {
    if (json.errors.some((e) => e.type === 'INSUFFICIENT_SCOPES')) {
      throw new GitHubError(
        'This token cannot read Projects. It needs a classic personal access token with both `repo` and `project` scopes — fine-grained tokens cannot access user-owned projects at all.',
        403
      );
    }
    throw new GitHubError(json.errors.map((e) => e.message).join('; '), res.status);
  }

  if (!json.data) throw new GitHubError(`GitHub returned no data (${res.status}).`, res.status);
  return json.data;
}

/**
 * Whether an owner is a User or an Organization.
 *
 * These are different GraphQL roots — `user(login:)` and `organization(login:)` — and
 * querying the wrong one returns `null` rather than an error, which surfaces as an
 * empty board with nothing to explain it. Resolved over REST because that endpoint
 * needs no special scope and answers in one hop.
 *
 * Cached for the process's life: an account does not change type.
 */
const ownerTypes = new Map<string, 'user' | 'organization'>();

export async function resolveOwnerRoot(token: string, login: string): Promise<'user' | 'organization'> {
  const cached = ownerTypes.get(login);
  if (cached) return cached;

  const res = await fetch(`${REST}/users/${encodeURIComponent(login)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
  }).catch((e: Error) => {
    throw new GitHubError(`Could not reach GitHub: ${e.message}`);
  });

  if (res.status === 404) throw new GitHubError(`No GitHub account called "${login}".`, 404);
  if (!res.ok) throw new GitHubError(`Could not look up "${login}" (${res.status}).`, res.status);

  const body = (await res.json()) as { type?: string };
  const root = body.type === 'Organization' ? 'organization' : 'user';
  ownerTypes.set(login, root);
  return root;
}

/**
 * The board, in one query per 100 items.
 *
 * `fields` is re-requested on every page and only the first page's copy is kept. It
 * could be split into its own query, but the field set is small and a single query
 * shape means one place where the read can go wrong. What it buys is that field and
 * option ids are always *discovered* rather than hardcoded — the plugin ships public
 * and works against any project without an account-specific constant in it.
 */
const BOARD_QUERY = (root: 'user' | 'organization') => `
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

// The GraphQL response, typed only as far as this file reads it.
interface RawItem {
  id: string;
  content: {
    number?: number;
    title?: string;
    body?: string | null;
    state?: string;
    url?: string;
    updatedAt?: string;
    repository?: { nameWithOwner: string };
    author?: { login: string; avatarUrl: string } | null;
    labels?: { nodes: Array<{ name: string; color: string }> };
    assignees?: { nodes: Array<{ login: string; avatarUrl: string }> };
    comments?: { totalCount: number };
  } | null;
  fieldValues: { nodes: Array<{ optionId?: string; field?: { id?: string } }> };
}

interface RawProject {
  id: string;
  title: string;
  url: string;
  fields: { nodes: Array<{ id?: string; name?: string; options?: Array<{ id: string; name: string }> }> };
  items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawItem[] };
}

/**
 * The query's root, keyed by owner root (`user` or `organization`).
 *
 * Named and applied as an explicit annotation on the `await` below rather than left to
 * the generic's inference: `cursor` is both an input to the call and assigned out of
 * its result, and TypeScript reads that as a value referenced in its own initializer
 * (TS7022). The annotation breaks the loop, and everything downstream — `project`,
 * `fields`, the `filter` callback — keeps its type instead of collapsing to `any`.
 */
type BoardQueryData = Partial<Record<'user' | 'organization', { projectV2: RawProject | null } | null>>;

function toContent(raw: RawItem): { content: ItemContent | null; draftTitle: string | null } {
  const c = raw.content;
  // A draft item has a title and nothing else; an item whose issue was deleted has
  // null content entirely. Both render, neither links.
  if (!c) return { content: null, draftTitle: null };
  if (c.number === undefined) return { content: null, draftTitle: c.title ?? null };
  return {
    draftTitle: null,
    content: {
      number: c.number,
      title: c.title ?? '',
      body: c.body ?? null,
      state: c.state ?? 'OPEN',
      url: c.url ?? '',
      updatedAt: c.updatedAt ?? '',
      repository: c.repository?.nameWithOwner ?? '',
      author: c.author ?? null,
      labels: c.labels?.nodes ?? [],
      assignees: c.assignees?.nodes ?? [],
      comments: c.comments?.totalCount ?? 0,
      // `state` is OPEN/CLOSED on an issue and OPEN/CLOSED/MERGED on a PR, so MERGED
      // is the only unambiguous tell available from the fields this query asks for.
      // Everything else about a PR reads identically to an issue.
      isPullRequest: c.state === 'MERGED'
    }
  };
}

export async function fetchBoard(config: ResolvedConfig): Promise<BoardData> {
  const root = await resolveOwnerRoot(config.token, config.owner);
  const query = BOARD_QUERY(root);

  let cursor: string | null = null;
  let fields: ProjectField[] = [];
  const items: ProjectItem[] = [];
  let projectId = '';
  let title = '';
  let url = '';

  for (let page = 0; page < MAX_PAGES; page++) {
    const data: BoardQueryData = await graphql<BoardQueryData>(config.token, query, {
      login: config.owner,
      number: config.projectNumber,
      cursor
    });

    const project: RawProject | null | undefined = data[root]?.projectV2;
    if (!project) {
      throw new GitHubError(
        `No project number ${config.projectNumber} on ${config.owner}. Check the number in Settings — it is the one in the project's URL.`,
        404
      );
    }

    if (page === 0) {
      projectId = project.id;
      title = project.title;
      url = project.url;
      // Non-single-select fields come back as `{}` from this query's inline fragment
      // and are dropped here — they have no options and nothing this plugin can write.
      fields = project.fields.nodes
        .filter((f): f is { id: string; name: string; options: Array<{ id: string; name: string }> } =>
          Boolean(f.id && f.name && f.options)
        )
        .map((f) => ({ id: f.id, name: f.name, options: f.options }));
    }

    for (const raw of project.items.nodes) {
      const singleSelect: Record<string, string> = {};
      for (const fv of raw.fieldValues.nodes) {
        // Same `{}` filtering as above: every field value that is not a single select
        // matches no fragment and arrives empty.
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

const SET_FIELD = `
mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
  updateProjectV2ItemFieldValue(input:{
    projectId:$projectId, itemId:$itemId, fieldId:$fieldId,
    value:{ singleSelectOptionId:$optionId }
  }) { projectV2Item { id } }
}`;

const CLEAR_FIELD = `
mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!) {
  clearProjectV2ItemFieldValue(input:{
    projectId:$projectId, itemId:$itemId, fieldId:$fieldId
  }) { projectV2Item { id } }
}`;

/**
 * Set — or unset — one single-select field on one item.
 *
 * A null `optionId` is a real operation, not an error case: dragging a card back to
 * "No Status" has to clear the field, and `updateProjectV2ItemFieldValue` has no way
 * to express "no value". `clearProjectV2ItemFieldValue` is a separate mutation, which
 * is why this takes the branch rather than the caller.
 */
export async function setSingleSelect(
  config: ResolvedConfig,
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string | null
): Promise<void> {
  if (optionId === null) {
    await graphql(config.token, CLEAR_FIELD, { projectId, itemId, fieldId });
    return;
  }
  await graphql(config.token, SET_FIELD, { projectId, itemId, fieldId, optionId });
}
