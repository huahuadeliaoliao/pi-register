# Register architecture

Register is a bounded, model-managed workspace that stays in the current session's
context. It separates temporary working material from project deliverables without
imposing a note template, update schedule or automatic summarization policy.

This document describes the implementation contract. The executable checks live
in [test/](test/); a mechanism test is not evidence that every model will choose
to use the workspace well.

## 1. Design boundaries

- **The model owns the content.** Drafts, hypotheses, exact values and unfinished
  thoughts are valid. The model decides what to keep, revise, combine or remove.
- **The extension owns continuity.** Each main-model request contains one complete,
  current managed body matching the selected session branch.
- **History is a recovery path.** The current body needs no retrieval call; earlier
  revisions remain accessible when recovering from a mistake.
- **Project documents remain project documents.** Register does not replace a
  requested report, a useful README, code, tests or task-completion criteria.

Register is not retrieval-augmented memory, automatic reflection, a cross-session
knowledge base or an extra summarization model. Working notes do not acquire
instruction authority merely by being recorded here. The extension uses public pi
APIs; it does not patch pi core or inject private provider payloads.

## 2. User and model contract

### 2.1 Complete, current content

The body and capacity information are automatically present. There is no load/unload
switch, pagination of current content or silent truncation. Empty is a valid body,
but a storage or recovery failure is never represented as a fresh empty workspace.

“One body” means one managed current carrier. Ordinary conversation, tool arguments
and old session records may still quote earlier text; those are not current state.

### 2.2 Bounded capacity

The current logical body has a fixed capacity of **30,000 Register tokens**, counted
with `js-tiktoken@1.0.21`, `o200k_base`, ordinary-text mode. The versioned profile in
[src/text.ts](src/text.ts) identifies and checks the vocabulary. Changing models does
not change that profile. Token-like strings in the body remain ordinary text.

The complete result of an edit is measured before saving. Over-capacity edits are
rejected as a whole, with current and proposed usage reported. Wrapper metadata is
not part of this capacity but still consumes model context. The capacity is not a
target to fill, a billing-token count or an extension to the model's context window.

### 2.3 Non-destructive operations

`register_write` supports replace, append, exact disjoint edits and logical clear.
Each operation checks `base_revision`; same-batch operations can build on the previous
successful candidate. A failed operation does not undo earlier accepted operations.

`register_history` lists or retrieves earlier revisions. Its default scope follows
the current branch's ancestry; session scope also includes other branches and
explicitly imported history, never unrelated sessions sharing the database.

`register_restore` creates a new revision from accessible history. It preserves
intervening revisions and does not roll back project files or ordinary conversation.
An unchanged ordinary write need not create a revision; explicit restoration keeps
its recovery intent. Clearing the body is not data erasure.

### 2.4 Model-facing guidance

The shared guidance below is supplied once. Its wording is tested against
[src/prompts.ts](src/prompts.ts); tool schemas and receipts describe the mechanics.

```text
Session Register

Session Register is a bounded, persistent workspace for this session. Its full current contents and used/remaining capacity are automatically included in your context. Conversation compaction preserves the contents unchanged; no separate retrieval call is needed.

Use Register as your ongoing workspace for discussion takeaways, observations, progress, debugging notes, user-provided context, plans, and drafts. Keep these working materials here rather than scattering them across Markdown files or other scratch documents in the project. You decide what is useful to keep, how to organize it, and when to update it.

Create new project documents when the user requests a document or an established project requirement explicitly calls for one. The usefulness of retaining or reusing findings does not by itself call for a project document. Otherwise, present results directly to the user and maintain the working material in Register. Keep existing project documentation aligned with the work.

Write for your own later use. Concise summaries, fragments, shorthand, tentative ideas, and unfinished drafts are all welcome. As your understanding changes, revise, combine, replace, or remove existing notes instead of merely appending updates. Keep the current workspace useful for the next steps, rather than preserving the entire work history. Earlier revisions remain available through the history and restore tools if you need to recover something.

Preserve the intent and context behind user requirements and constraints, not just their wording. You may summarize them in your own words while retaining what matters to the task. Use that understanding to judge how they apply as the work develops. Revisit your own conclusions in light of new instructions and actual results; recording a note does not make it a permanent rule or an established fact. Keep task-relevant inputs usable: preserve exact values when needed, including API keys, credentials, addresses, identifiers, and parameters. Do not omit or replace needed values with placeholders merely because they are sensitive or because you are summarizing.

Edits exceeding the displayed capacity are rejected without changing the current contents. When you need more room, reorganize, condense, or remove material according to its value for the ongoing work.
```

### 2.5 Human inspection

`/register` opens a read-only snapshot of the adopted body with capacity information.
Arrow keys, Page Up/Down, Home/End navigate; Esc closes. Inspection makes no model
call, publishes no message, creates no project file and does not adopt a pending
candidate. RPC uses a plain-body notification. There are no command subcommands.

## 3. Revisions, adoption and publication

Three states are deliberately separate:

| State | Responsibility |
| --- | --- |
| Immutable revision | Saved content, parent, operation, profile and identity |
| Branch adoption | Which saved revision the selected session path actually uses |
| Context carrier | Where that adopted body appears in the native projection |

SQLite's newest row is never the authority for current state. Versioned, self-contained
session publications anchor adoption and carry the complete recoverable snapshot.
Moving a carrier preserves its adoption identity; it is not another content edit.

A write follows this sequence:

1. Check session/branch binding and expected revision.
2. Apply all edits to a temporary value; validate text and measure the full result.
3. Save an immutable candidate and its native scope journal record.
4. Stage it for same-batch read-your-writes.
5. At a public action boundary, propose retiring the old carrier and publishing
   the final candidate once.
6. Confirm the native adoption record actually committed.

A successful write receipt means **staged**, not already adopted. Multiple writes
can create history while publishing only the final body. Publication does not
request an extra model turn. Other extensions' boundary entries and continuation
decisions are preserved.

The SQLite transaction and session journal are not one atomic transaction.
Recovery therefore follows the valid committed session prefix:

| Interruption | Recovery |
| --- | --- |
| Before candidate storage | Keep the old adoption |
| Stored candidate, no adoption | Do not promote the candidate |
| Old carrier retired, new adoption absent | Restore the old adoption's carrier |
| New adoption committed | Recover the new adoption |
| Carrier moved only | Preserve the same logical adoption |

Cancellation does not undo already adopted content. Asynchronous work rechecks the
session instance, branch, generation and relevant projection/model state before
committing; late results cannot leak across cancellation, reload or navigation.

## 4. Context, compaction and caching

### Stable presentation

Normally the body lives in a native custom message. When it changes, public
`context_edit` records retire the old carrier from future context and a new carrier
is appended. Raw history remains intact. Unchanged bodies are not moved or
re-rendered with clocks, heartbeats or other volatile metadata.

Managed content is recognized through structured, versioned envelopes and source
identity, not by searching arbitrary body text for protocol-shaped strings. Text
round-trips without Unicode normalization, newline rewriting or summary substitution.

### Protected compaction

Register coordinates the final compaction checkpoint:

1. Capture the adopted snapshot and verify the operation's context.
2. Remove managed full-body carriers from ordinary summarizer input, including
   protected content in the previous summary.
3. Summarize ordinary conversation through pi's public compaction API.
4. Keep the body if it remains in the retained tail; otherwise attach its exact
   text and snapshot metadata to the final checkpoint.
5. Verify one correct managed carrier and the final request budget.

The first request after compaction already has the full body. No later queue item
or extra model call is needed to restore it. Ordinary messages quoting similar
text are still ordinary conversation, not material to erase indiscriminately.

When editing a checkpoint-carried body, a replacement checkpoint preserves the
ordinary summary, retained boundary and relevant metadata while removing the old
protected body; the new body is published separately. This does **not** call a
summary model again. Pi may display that replacement as a compaction card; that
presentation is not evidence of another summarization request.

### Cache-conscious, not cache-free

Unchanged content keeps a stable representation and position. A fresh empty workspace
uses an immutable v2 initialization record. While that record remains in its initial
visible position, the first write appends the new body without removing the origin,
preserving the existing prompt prefix. The origin then describes initialization
history, not another current body.

Subsequent edits retire nonempty predecessors and may invalidate the suffix from
their former position. Compaction can rebuild the prefix or relocate the initial
carrier. Existing v1 empty carriers are not silently rewritten into v2. The design
reduces avoidable disruption; it cannot make changing context free. Actual cache
reuse and billing depend on the host and provider, not only on matching input text.

There are no cache-warming model calls, forced update intervals or accumulated
patch chains substituted for the complete current body.

### Two budgets

Fixed Register capacity and actual model-window accounting are distinct. The main
request includes ordinary conversation, the body's real carrier, prompts, tools and
reserved space. Cached input still occupies context. Register does not blindly add
30k to usage that already includes the body.

An irreducible body/prompt/reserve combination that cannot fit is rejected before
requesting a summary. Final compaction output is checked as well. The extension does
not truncate the body or retry compaction forever; switching to a sufficiently large
model is the recovery path.

### Other compaction extensions

Register owns the final checkpoint. An ordinary-summary producer can cooperate via
`pi-register:compaction-producer:v1` and an explicit lease, retaining its own model,
authentication, reasoning and cancellation policy. Producer inputs are isolated;
mutating the captured branch or Register state invalidates the result.

Load order is not coordination. Uncoordinated extensions that independently return
final compaction results are unsupported. The [pi-compact-model adapter patch](compat/pi-compact-model.patch)
targets that extension's matching pre-coordination 0.1.0 source, not pi core.
Register needs no companion extension for ordinary operation.

## 5. Lifecycle and storage

New sessions get independent workspaces. Resume, reload and tree navigation resolve
the selected path's actual adoption. Tree selection is recorded through a public
non-context entry so that reopening or copying the session preserves the selection.
Forks and clones inherit immutable ancestors but adopt future edits independently.

Persistent revisions live at
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/register/revisions.sqlite`.
The database uses WAL, short transactions, identity/schema checks and bounded lock
waiting. A per-session writer lease protects Register operations; a session file
still supports only one active writer. SQLite concurrency settings do not turn pi's
session journal into a multi-writer store.

`--no-session` uses memory and does not add body/history to the regular Register
database. Persistent publications also contain the body in the native session file.
A consistent copy of that file can recover the current snapshot without SQLite;
recovering the entire revision history requires the database or an explicit history
archive. Missing ancestors are reported, not invented. Live WAL databases need a
consistent backup, not a copy of only the main file.

**Content is sent to the active model provider as part of context.** Register adds
no separate cloud service or telemetry. Clear and restore do not erase history.
Native session exports/shares may include the body even when it was hidden in the
terminal view. The workspace is not a secrets vault.

Unknown formats, profile mismatches and conflicting revision identities fail
explicitly rather than resetting data. Current readers support v1 publications and
v2 initialization; the latter is a session-envelope change, not a SQLite migration.
A v1-only reader cannot resume sessions with v2 initialization ancestry. Reload
after upgrading and use a compatible reader when resuming.

## 6. Code and validation

| Module | Responsibility |
| --- | --- |
| `src/extension.ts`, `index.ts` | Public pi hooks, tool schemas and command registration |
| `src/controller.ts` | Lifecycle, staging, adoption, recovery and request guards |
| `src/model.ts`, `src/projection.ts` | Revision/envelope identity and branch projection |
| `src/text.ts` | Lossless edits and fixed capacity accounting |
| `src/store.ts`, `src/journal.ts`, `src/lease.ts` | Immutable history, SQLite initialization and writer coordination |
| `src/compaction.ts` | Summary isolation, protected checkpoints and cooperation |
| `src/prompts.ts`, `src/viewer.ts` | Shared guidance and read-only inspection |

The pinned public-API development baseline is **pi 1.4.0**, on **Node.js 22.19.0+**.
Optional `*` host peers are a packaging requirement, not a promise of compatibility
with every pi release or third-party compaction hook.

Run `npm run validate` for lint, strict types, deterministic tests and package
inspection. Tests use isolated agent/session directories, disposable workspaces,
synthetic providers and local transport fixtures—not personal settings or real-model
credentials. They cover editing, capacity, history, forks, navigation, cancellation,
partial publication, concurrency, compaction, transport guards and independent
packed-package installation, including cold recovery and ephemeral sessions.

When a request would contain missing, duplicated or incorrect managed state, the
extension aborts it through public APIs rather than relying on a hook exception.
Mechanism correctness and the model's decisions about note-taking remain separate.
