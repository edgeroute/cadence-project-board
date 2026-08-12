import Anthropic from '@anthropic-ai/sdk';
import type { BoardData, ProjectItem } from '../frontend/types';
import { fieldByName, PRIORITY_FIELD, SIZE_FIELD } from '../frontend/types';
import * as claudeCli from './claude-cli.service';

/**
 * Suggesting a Priority and a Size for every item on the board.
 *
 * Modelled on szmidtpiotr/claude-github-issue's AI-prioritize feature, with one
 * structural difference that follows from the data model: that plugin holds its
 * priorities in an in-memory map that dies with the tab, because its board has nowhere
 * to put them. This board has real `Priority` and `Size` fields, so a suggestion here
 * is a *proposed write*.
 *
 * That is why nothing in this file writes anything. It returns suggestions; the reader
 * reviews them and applies the ones they accept, through the same `/field` route a drag
 * uses. Writing 17 fields from a model's first answer is a large, hard-to-undo change
 * to somebody's board made without them looking at it — and the review step costs one
 * click.
 */

/** What the model (or the heuristic) proposes for one item. */
export interface Suggestion {
  /** The **item** id (`PVTI_…`) — what a write addresses. See `ProjectItem`. */
  itemId: string;
  /** Display only, so the reader can recognise the row. */
  number: number | null;
  title: string;
  /** An option *name* from the project's own Priority field, or null to leave it alone. */
  priority: string | null;
  /** An option *name* from the project's own Size field, or null. */
  size: string | null;
  /** One line of justification, shown beside the suggestion. */
  reason: string;
}

export interface PrioritizeResult {
  suggestions: Suggestion[];
  /**
   * Which engine produced these, so the UI can say so rather than implying a model ran.
   *
   * The two Claude paths are reported separately rather than collapsed into one
   * `'claude'`, because they differ in the thing a reader would want to know: which
   * account is being spent. `claude-api` bills the pasted API key; `claude-cli` spends
   * the Claude Code login already signed in on this machine.
   */
  source: 'claude-api' | 'claude-cli' | 'heuristic';
  /** Set when the model was wanted but could not run — the heuristic answered instead. */
  note?: string;
}

/** Everything the model is shown about one item. Deliberately small — see `buildInput`. */
interface ItemBrief {
  number: number | null;
  title: string;
  state: string;
  labels: string[];
  comments: number;
  ageDays: number;
  excerpt: string;
}

/** Bodies are long and mostly boilerplate; the opening is where the problem is stated. */
const EXCERPT_CHARS = 600;
/** A ceiling on how many items go to the model in one request. */
const MAX_ITEMS = 200;

function ageInDays(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
}

/**
 * What actually leaves the machine.
 *
 * Titles, labels, a body excerpt, and three numbers. Not the author, not the assignees,
 * not the repository, not the comment threads, and not the reader's own project or
 * token. A board is often somebody's private backlog, so the rule is that this function
 * is the *only* place the outbound payload is decided, and it is short enough to read
 * in full before agreeing to it.
 */
function buildInput(items: ProjectItem[]): { briefs: ItemBrief[]; ids: string[] } {
  const briefs: ItemBrief[] = [];
  const ids: string[] = [];
  for (const item of items.slice(0, MAX_ITEMS)) {
    const c = item.content;
    briefs.push({
      number: c?.number ?? null,
      title: c?.title ?? item.draftTitle ?? 'Untitled',
      state: c?.state ?? 'OPEN',
      labels: (c?.labels ?? []).map((l) => l.name),
      comments: c?.comments ?? 0,
      ageDays: c?.createdAt ? ageInDays(c.createdAt) : 0,
      excerpt: (c?.body ?? '').slice(0, EXCERPT_CHARS)
    });
    ids.push(item.id);
  }
  return { briefs, ids };
}

// ---------------------------------------------------------------------------
// The heuristic — the answer when there is no API key, and the floor when there is.
// ---------------------------------------------------------------------------

/*
  Two kinds of token, and the difference is not cosmetic.

  `STEM` patterns carry a leading `\b` only, so they match the whole word family:
  `migrat` finds "migration" and "migrating". `WORD` patterns carry boundaries on both
  sides, so they match exactly: `docs?` must not find "docker", and `label` must not find
  "labelable".

  Writing every token one way breaks the other half. A single `\b(...)\b` list — which is
  what this started as — silently never matched `migrat`, `vulnerab`, or `architect`,
  because the trailing boundary cannot follow a prefix; the scorer looked like it worked
  and simply ignored a third of its own vocabulary. A single leading-boundary list instead
  scores "docker" as documentation.
*/
const HIGH_STEM = /\b(crash|vulnerab|regress|corrupt|leak|block)/i;
const HIGH_WORD = /\b(data.?loss|security|broken|silent|urgent|blocker)\b/i;

const LOW_STEM = /\b(cosmetic|polish)/i;
const LOW_WORD = /\b(nit|nitpick|typo|cleanup|docs?|comment|rename|wording)\b/i;

const BIG_STEM = /\b(migrat|rewrit|refactor|architect|redesign|overhaul)/i;
const BIG_WORD = /\b(epic|tracking|umbrella)\b/i;

const SMALL_STEM = /\b(typo|renam)/i;
const SMALL_WORD = /\b(bump|one.?line|constant|copy|wording|label)\b/i;

const HIGH_SIGNALS = { stem: HIGH_STEM, word: HIGH_WORD };
const LOW_SIGNALS = { stem: LOW_STEM, word: LOW_WORD };
const BIG_SIGNALS = { stem: BIG_STEM, word: BIG_WORD };
const SMALL_SIGNALS = { stem: SMALL_STEM, word: SMALL_WORD };

function hits(signals: { stem: RegExp; word: RegExp }, text: string): boolean {
  return signals.stem.test(text) || signals.word.test(text);
}

/**
 * A priority and size guess from words and numbers alone.
 *
 * Kept deliberately crude, and kept *whatever* happens to the model path: it is the
 * answer for a reader with no API key, and it is what runs when the request fails. A
 * feature that only works with a paid key attached is a feature most readers meet as an
 * error message.
 *
 * It scores rather than classifies so the ordering is stable, then maps the score onto
 * whatever options the project actually defines — a board with `Critical/Major/Minor`
 * gets those words back, not `P0`.
 */
function heuristicFor(brief: ItemBrief, priorities: string[], sizes: string[]): { priority: string | null; size: string | null; reason: string } {
  const haystack = `${brief.title} ${brief.labels.join(' ')} ${brief.excerpt}`;

  let urgency = 0;
  const reasons: string[] = [];
  if (hits(HIGH_SIGNALS, haystack)) {
    urgency += 2;
    reasons.push('mentions a failure or security signal');
  }
  if (hits(LOW_SIGNALS, haystack)) {
    urgency -= 1;
    reasons.push('reads as polish');
  }
  if (brief.comments >= 5) {
    urgency += 1;
    reasons.push(`${brief.comments} comments`);
  }
  if (brief.ageDays > 120) {
    urgency -= 1;
    reasons.push(`open ${brief.ageDays} days`);
  }

  let effort = 1;
  if (hits(BIG_SIGNALS, haystack)) {
    effort += 1;
    reasons.push('looks like a large change');
  }
  if (hits(SMALL_SIGNALS, haystack)) {
    effort -= 1;
    reasons.push('looks small');
  }

  // Clamped into the project's own option lists, whatever they are and however many.
  const pIndex = Math.min(priorities.length - 1, Math.max(0, urgency >= 2 ? 0 : urgency >= 1 ? 1 : 2));
  const sIndex = Math.min(sizes.length - 1, Math.max(0, effort));

  return {
    priority: priorities.length ? priorities[pIndex] : null,
    size: sizes.length ? sizes[sIndex] : null,
    reason: reasons.length ? reasons.join('; ') : 'no strong signal — middle of the range'
  };
}

// ---------------------------------------------------------------------------
// The model path.
// ---------------------------------------------------------------------------

/**
 * The model this asks by default.
 *
 * Deliberately the current flagship rather than the cheapest model that could do it.
 * The upstream plugin reaches for a small model here, and that is a reasonable default
 * for *its* feature — a transient in-memory ordering. This one proposes writes to a
 * shared board, so the cost of a bad call is a wrong priority somebody acts on. A
 * reader who wants the cheaper trade can say so; `aiModel` in the project's config file
 * overrides it, and that choice is theirs rather than one made quietly on their behalf.
 */
export const DEFAULT_MODEL = 'claude-opus-5';

/** Enough room for adaptive thinking *and* a suggestion per item — both share the cap. */
const MAX_TOKENS = 16000;

const SYSTEM = `You triage a software project's backlog.

For each item you are given, propose a Priority and a Size using ONLY the option names
listed in the user message. Judge:

- Priority by user-facing impact and urgency — what breaks, for whom, and how soon.
  A crash, data loss, or a silent wrong answer outranks a papercut. Age alone is not
  urgency: an old issue nobody hit is not urgent, and a new one that breaks a core
  flow is.
- Size by the likely extent of the change, not by how hard it is to decide. A one-line
  fix whose diagnosis took a week is still small.

Rules:
- Use only the option names given. Never invent one.
- Return exactly one entry per item, in the order given, keyed by "index".
- "reason" is one short clause, under 15 words, naming the evidence you used. Do not
  restate the title.
- If an item genuinely gives you nothing to judge on, say so in the reason and still
  pick the middle option rather than refusing.`;

interface ModelSuggestion {
  index: number;
  priority: string;
  size: string;
  reason: string;
}

/** The board, as the model sees it. Shared so both engines are asked the same question. */
function userPrompt(briefs: ItemBrief[], priorities: string[], sizes: string[]): string {
  return [
    `Priority options, most urgent first: ${priorities.join(', ')}`,
    `Size options, smallest first: ${sizes.join(', ')}`,
    '',
    'Items:',
    JSON.stringify(briefs.map((b, index) => ({ index, ...b })), null, 1)
  ].join('\n');
}

/**
 * Ask Claude for a Priority and a Size per item.
 *
 * Three things here are worth not undoing:
 *
 * **The schema's enums come from the project.** `priority` and `size` are constrained to
 * the board's own option names, so the model cannot return a `P3` this project has no
 * field option for. That is what makes the result directly applicable — every value
 * comes back already valid for a write.
 *
 * **Items are addressed by index, not by issue number.** A model asked to echo an
 * identifier will occasionally mistype it, and a mistyped issue number is a suggestion
 * silently applied to the wrong row. An index is checked against the array on return.
 *
 * **It streams.** Adaptive thinking is on by default on this model and shares `max_tokens`
 * with the answer, so a 100-item board is a long single request — long enough to reach an
 * HTTP timeout on a non-streaming call.
 */
async function askClaudeApi(
  apiKey: string,
  model: string,
  briefs: ItemBrief[],
  priorities: string[],
  sizes: string[]
): Promise<ModelSuggestion[]> {
  const client = new Anthropic({ apiKey });

  const schema = {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            priority: { type: 'string', enum: priorities },
            size: { type: 'string', enum: sizes },
            reason: { type: 'string' }
          },
          required: ['index', 'priority', 'size', 'reason'],
          additionalProperties: false
        }
      }
    },
    required: ['suggestions'],
    additionalProperties: false
  };

  const stream = client.messages.stream({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: userPrompt(briefs, priorities, sizes) }]
  });

  const message = await stream.finalMessage();

  // A refusal is a 200 with an empty or partial `content`, so reading content[0]
  // unconditionally would throw on exactly the response that most needs explaining.
  if (message.stop_reason === 'refusal') {
    throw new Error('Claude declined to triage this board.');
  }

  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  if (!text) throw new Error('Claude returned no suggestions.');

  const parsed = JSON.parse(text) as { suggestions?: ModelSuggestion[] };
  return parsed.suggestions ?? [];
}

/**
 * The same question, asked through the Claude Code CLI already signed in on this machine.
 *
 * This is the path a reader gets **without configuring anything**, and it exists because
 * requiring an API key here was asking someone to pay twice for Claude while running
 * inside Claude Code. See `claude-cli.service` for why the binary is reachable at all.
 *
 * It differs from the API path in one way that matters: `-p` has no equivalent of
 * `output_config.format`, so nothing *constrains* the reply to the schema — the shape is
 * requested in prose and can come back wrong. Two consequences follow:
 *
 * - The JSON is extracted rather than parsed, because a headless turn may still wrap it
 *   in a fence or a sentence (`extractJson`).
 * - The option-name check in `prioritize` stops being belt-and-braces and becomes the
 *   only thing standing between an invented `P3` and a write. That check is on the merge
 *   loop, shared by both engines, and must not be relaxed on the assumption that the
 *   schema already did the work — on this path there is no schema.
 */
async function askClaudeCli(
  model: string,
  briefs: ItemBrief[],
  priorities: string[],
  sizes: string[]
): Promise<ModelSuggestion[]> {
  const prompt = [
    SYSTEM,
    '',
    // Stated twice as strongly as the API path needs to state it: there, the schema is
    // enforced by the server, and the prompt is a hint. Here, the prompt is all there is.
    'Reply with a single JSON object and nothing else — no prose before or after it, no',
    'markdown code fence. Its shape is exactly:',
    '{"suggestions":[{"index":<integer>,"priority":<option name>,"size":<option name>,"reason":<string>}]}',
    '',
    userPrompt(briefs, priorities, sizes)
  ].join('\n');

  const parsed = claudeCli.extractJson(await claudeCli.ask(model, prompt)) as {
    suggestions?: ModelSuggestion[];
  };
  return Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
}

/**
 * Suggestions for the whole board, from the best engine available.
 *
 * The order is **API key, then the local Claude Code CLI, then keyword scoring.**
 *
 * The key comes first because explicit configuration beats an ambient credential — the
 * same precedence the GitHub token follows. Someone who went and pasted a key meant to
 * use it, and quietly preferring their Claude Code subscription would spend the wrong
 * account without asking.
 *
 * The CLI comes second because it is free at the point of use for anyone already signed
 * in to Claude Code, which — this being a claudecodeui plugin — is everyone. It makes the
 * feature work out of the box rather than behind a credential.
 *
 * The heuristic runs **first, always**, and whichever model answers is merged over it. So
 * a model that returns 15 suggestions for 17 items leaves two heuristic rows rather than
 * two blanks, and a model that fails entirely degrades to a complete heuristic pass
 * instead of an error. The reader is told which engine answered either way — a suggestion
 * labelled as Claude's when a regex produced it is the one outcome that would make this
 * feature untrustworthy.
 */
export async function prioritize(
  board: BoardData,
  items: ProjectItem[],
  apiKey: string | null,
  model: string
): Promise<PrioritizeResult> {
  const priorityField = fieldByName(board.fields, PRIORITY_FIELD);
  const sizeField = fieldByName(board.fields, SIZE_FIELD);
  const priorities = priorityField?.options.map((o) => o.name) ?? [];
  const sizes = sizeField?.options.map((o) => o.name) ?? [];

  if (!priorities.length && !sizes.length) {
    throw new Error(`This project defines neither a "${PRIORITY_FIELD}" nor a "${SIZE_FIELD}" field, so there is nothing to suggest.`);
  }

  const { briefs, ids } = buildInput(items);

  const suggestions: Suggestion[] = briefs.map((b, i) => {
    const h = heuristicFor(b, priorities, sizes);
    return { itemId: ids[i], number: b.number, title: b.title, priority: h.priority, size: h.size, reason: h.reason };
  });

  const engine: 'api' | 'cli' | null = apiKey ? 'api' : (await claudeCli.isAvailable()) ? 'cli' : null;

  if (!engine) {
    return {
      suggestions,
      source: 'heuristic',
      note: 'These come from keyword scoring: there is no Anthropic API key set, and the claude CLI could not be run. Either one gets you a real read of each issue.'
    };
  }

  try {
    const proposed =
      engine === 'api'
        ? await askClaudeApi(apiKey as string, model, briefs, priorities, sizes)
        : await askClaudeCli(model, briefs, priorities, sizes);

    for (const s of proposed) {
      // An out-of-range index is dropped rather than clamped: clamping would attach a
      // model's reasoning about one issue to a different one, which is worse than
      // leaving that row on its heuristic guess.
      if (!Number.isInteger(s.index) || s.index < 0 || s.index >= suggestions.length) continue;
      const target = suggestions[s.index];
      if (priorities.includes(s.priority)) target.priority = s.priority;
      if (sizes.includes(s.size)) target.size = s.size;
      if (s.reason) target.reason = s.reason;
    }
    return { suggestions, source: engine === 'api' ? 'claude-api' : 'claude-cli' };
  } catch (e) {
    return {
      suggestions,
      source: 'heuristic',
      note: `Claude couldn't be reached (${(e as Error).message}) — these are keyword-scored instead.`
    };
  }
}

/** Whether AI Prioritize can reach a model at all, for the settings screen to report. */
export function claudeCliAvailable(): Promise<boolean> {
  return claudeCli.isAvailable();
}
