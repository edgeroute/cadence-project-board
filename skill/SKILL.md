---
name: board
description: Read and change a GitHub Projects v2 board from the terminal — show the columns, move an item between them, and set its Priority or Size. Reads config from .CadenceBoard/project-board.json in the current project. Use when the user invokes /board or asks to "show the board", "what's in progress", "move 216 to ready", "set 218 to P1", "what's in the backlog", or to triage issues onto the project board.
---

# board

The chat half of the Project Board tab. Both read the same config file and issue the
same GraphQL, so what you do here shows up there on its next refresh, and vice versa.

## Why this talks to GitHub directly

The plugin runs a backend, but its port is assigned at startup and reported only to
claudecodeui — nothing outside that process can address it. So this skill reads the
same config and calls the GitHub API itself. The config file and the mutation shapes
below are the shared contract, not an HTTP route.

## Setup

Read the config from the project root:

```bash
cat .CadenceBoard/project-board.json
```

It holds `owner`, `projectNumber`, and usually `token`. If `token` is absent, fall back
to `$GH_TOKEN` or `$GITHUB_TOKEN` — the plugin does the same. If the file is missing,
tell the user to open the Project Board tab and press ⚙; do not guess an owner or a
project number.

The token must be a **classic** PAT with `repo` and `project` scopes. If a call comes
back `INSUFFICIENT_SCOPES`, that is the cause — fine-grained tokens cannot read
user-owned projects at all, and no amount of permission-ticking will fix one.

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('.CadenceBoard/project-board.json')).get('token',''))")
TOKEN=${TOKEN:-$GH_TOKEN}
OWNER=$(python3 -c "import json;print(json.load(open('.CadenceBoard/project-board.json'))['owner'])")
NUMBER=$(python3 -c "import json;print(json.load(open('.CadenceBoard/project-board.json'))['projectNumber'])")
```

## Owner root

`user(login:)` and `organization(login:)` are different GraphQL roots, and querying the
wrong one returns `null` rather than an error — an empty board with nothing to explain
it. Check once:

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/users/$OWNER \
  | python3 -c "import json,sys;print('organization' if json.load(sys.stdin).get('type')=='Organization' else 'user')"
```

Use that word as `ROOT` below.

## Read the board

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST https://api.github.com/graphql -d @- <<JSON
{"query":"query(\$login:String!,\$number:Int!){ ROOT(login:\$login){ projectV2(number:\$number){ id title url fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}} items(first:100){nodes{ id content{... on Issue{number title state url repository{nameWithOwner}}} fieldValues(first:20){nodes{... on ProjectV2ItemFieldSingleSelectValue{optionId field{... on ProjectV2FieldCommon{id name}}}}} }} } } }",
 "variables":{"login":"$OWNER","number":$NUMBER}}
JSON
```

Substitute the real root for `ROOT` before sending. Note the two things that trip
people up:

- **An item is not an issue.** Every item has a `PVTI_…` id of its own, and that — not
  the issue number — is what mutations address. The issue number is display text.
- **`fieldValues` returns `{}` for every value that is not a single select.** Filter
  those out rather than treating them as data.

Group items by the `Status` field's option name and print one section per column, in
the order `fields` returns the options:

```
Cadence Dev Pipeline — 17 items

BACKLOG (15)
  #214  Nothing in the app announces itself as a heading
  #215  Every error message in the app is shown and never announced
  …

IN PROGRESS (2)
  #137  EAS Update ships unsigned JavaScript
  #205  First launch after an update hangs on a spinner
```

Items with no Status go under `NO STATUS`. Never drop them — a board that hides items
is worse than no board.

## Move an item, or set Priority / Size

All three are single-select fields, so all three are this one mutation with a different
`fieldId`. Resolve the item id from the issue number, and the field and option ids by
name, out of the read above.

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST https://api.github.com/graphql -d @- <<JSON
{"query":"mutation(\$p:ID!,\$i:ID!,\$f:ID!,\$o:String!){updateProjectV2ItemFieldValue(input:{projectId:\$p,itemId:\$i,fieldId:\$f,value:{singleSelectOptionId:\$o}}){projectV2Item{id}}}",
 "variables":{"p":"$PROJECT_ID","i":"$ITEM_ID","f":"$FIELD_ID","o":"$OPTION_ID"}}
JSON
```

To clear a field — which is how an item goes back to **No Status** — it is a *different*
mutation, because `updateProjectV2ItemFieldValue` has no way to express "no value":

```bash
{"query":"mutation(\$p:ID!,\$i:ID!,\$f:ID!){clearProjectV2ItemFieldValue(input:{projectId:\$p,itemId:\$i,fieldId:\$f}){projectV2Item{id}}}",
 "variables":{"p":"$PROJECT_ID","i":"$ITEM_ID","f":"$FIELD_ID"}}
```

## Commands

| Invocation | Do this |
| :-- | :-- |
| `/board` | Read and print every column |
| `/board 216` | Print one item: its title, column, Priority, Size, URL |
| `/board move 216 ready` | Set `Status`. Match the option name case-insensitively |
| `/board move 216 none` | Clear `Status` |
| `/board priority 216 P1` | Set `Priority` |
| `/board size 216 XS` | Set `Size` |

Match option names case-insensitively and accept unambiguous prefixes (`prog` →
`In progress`). If a name matches nothing, list the real options rather than guessing —
a mutation with a wrong option id fails in a way that reads like the board is broken.

## Rules

- **Never invent an option.** Options are defined on the project; a new one has to be
  added on github.com first.
- **Report what actually happened.** Say the column it moved from and to. On failure,
  give GitHub's own message — it is usually specific ("Could not resolve to a node").
- **One item at a time unless asked.** Bulk moves are easy to get wrong and hard to
  undo; if the user asks for several, list what you are about to do first.
