# SDD: Client-only AI sidebar backed by a hidden Telegram forum

Status: planned
Owner: Telegram WebA fork
Target branch: `external-transcription`

## 1. Objective

Add a right-side AI chat panel to the Telegram Web client without introducing a bot, an application-side conversation store, or a server that receives private Telegram history or model API keys.

The Telegram client itself must:

- create and manage a private service supergroup;
- enable forum mode on that supergroup;
- archive and mute the service group;
- keep the service group hidden in the custom client UI;
- create one forum topic per source chat or AI session;
- store AI conversation records as ordinary Telegram messages inside those topics;
- parse the topic history into a rich sidebar UI;
- call the configured OpenAI-compatible model endpoint directly from the client;
- execute Telegram tools locally using the authenticated user session.

Telegram cloud history is the only cross-device synchronization layer for AI state.

## 2. Non-goals

The first implementation does not:

- run a Telegram bot;
- store chat history, API keys, AI messages, tool calls, or workspace state on an application server;
- copy complete source chats into the workspace;
- permit autonomous mutating Telegram actions without user confirmation;
- attempt end-to-end encryption beyond Telegram's existing cloud-chat model;
- expose the service supergroup as a normal conversation in the custom client UI.

## 3. User experience

### 3.1 First use

1. User opens any Telegram chat.
2. User presses the existing AI button.
3. Client searches for an existing AI workspace supergroup.
4. If none exists, client creates a private supergroup with forum mode enabled.
5. Client applies a permanent mute and moves the group to Archive.
6. Client writes a versioned workspace metadata record.
7. Client creates a forum topic mapped to the current source chat.
8. The right-side AI panel opens and renders that topic as an AI conversation.

### 3.2 Subsequent use

1. User opens a source chat.
2. Client resolves the corresponding forum topic.
3. Client loads and parses topic history.
4. User sends a prompt in the sidebar.
5. Client stores the prompt as a marked Telegram message in the topic.
6. Client calls the selected LLM endpoint directly.
7. Streaming output is rendered locally.
8. Final assistant output and relevant execution records are appended to the same topic.

### 3.3 New device recovery

1. Client discovers the existing workspace group.
2. Client reads workspace metadata.
3. Client loads forum topics and topic metadata records.
4. Client reconstructs source-chat-to-topic mappings.
5. Client parses topic messages and rebuilds AI conversations locally.

No separate account registration or server-side migration is required.

## 4. High-level architecture

```text
Telegram Web client
├── AI sidebar UI
├── Workspace discovery and lifecycle
├── Topic mapping registry
├── Message envelope codec
├── Conversation reducer/parser
├── Local LLM transport
├── Telegram tool runtime
├── Confirmation and policy layer
└── Local secret/config storage
         │
         ├── Telegram MTProto session → private archived forum supergroup
         └── HTTPS → user-configured OpenAI-compatible endpoint
```

Application servers are not in the data path.

## 5. Workspace supergroup

### 5.1 Properties

The workspace must be:

- private;
- a supergroup;
- forum-enabled;
- owned by the current user;
- without any bot dependency;
- muted indefinitely;
- archived immediately after creation;
- filtered out of ordinary chat lists in the custom client;
- still recoverable through an internal diagnostic screen.

### 5.2 Discovery

Discovery must not rely only on the visible group title.

Use two independent identifiers:

1. a stable local reference to the Telegram peer ID when available;
2. a signed or checksum-protected workspace metadata record in the General topic.

Fallback discovery may search archived dialogs for a matching metadata envelope.

### 5.3 Workspace metadata

The first metadata record should contain:

```json
{
  "schema": 1,
  "kind": "workspace",
  "workspaceId": "uuid",
  "createdByAccountId": "telegram-user-id",
  "createdAt": "ISO-8601",
  "protocolVersion": 1
}
```

The client must treat all Telegram message content as untrusted input even when it appears in the user's own group.

## 6. Topic mapping

### 6.1 Default mapping

Default rule:

```text
(accountId, sourcePeerId, sourceThreadId|null) → workspaceTopicId
```

A source forum topic therefore maps independently from its parent group when `sourceThreadId` is present.

### 6.2 Topic metadata record

Each workspace topic begins with a metadata record:

```json
{
  "schema": 1,
  "kind": "session",
  "sessionId": "uuid",
  "sourceAccountId": "telegram-user-id",
  "sourcePeerId": "telegram-peer-id",
  "sourceThreadId": null,
  "createdAt": "ISO-8601",
  "titleSnapshot": "Chat title"
}
```

Names are display hints only. Telegram IDs are authoritative.

### 6.3 Multiple sessions per chat

Version 1 may enforce one topic per source chat. The schema must still include `sessionId` so later versions can support multiple AI sessions for one chat without migration breakage.

## 7. Message envelope protocol

### 7.1 Goals

The protocol must:

- distinguish user prompts, assistant text, tool calls, tool results, and metadata;
- survive ordinary Telegram synchronization;
- remain human-readable after the envelope;
- be versioned;
- fail closed for execution;
- display malformed or unknown records as plain text;
- avoid relying on one magic Unicode character as authorization.

### 7.2 Wire format

Initial textual framing:

```text
<MAGIC><VERSION><TYPE><SPACE><BASE64URL(JSON_HEADER)><NEWLINE><HUMAN_TEXT>
```

Recommended logical fields:

```json
{
  "id": "uuid",
  "runId": "uuid|null",
  "timestamp": "ISO-8601",
  "contentHash": "sha256",
  "replyToRecordId": "uuid|null"
}
```

The exact rare Unicode magic prefix will be selected during implementation after compatibility testing across Telegram clients, normalization forms, copy/paste, search, and message editing.

### 7.3 Record types

| Code | Meaning | Executable |
|---|---|---|
| `U` | user prompt | no |
| `A` | assistant text | no |
| `C` | tool call proposal | no, until policy check |
| `R` | tool result | no |
| `M` | workspace/session metadata | no |
| `S` | system/runtime note | no |
| `E` | error or cancellation | no |

### 7.4 Parsing rules

1. Check exact magic prefix.
2. Validate protocol version.
3. Validate type code.
4. Decode bounded header size.
5. Validate strict schema.
6. Verify content hash when present.
7. Reject duplicates by record ID.
8. Never execute while replaying history.
9. Treat unknown versions and malformed payloads as normal text.

### 7.5 Editing and deletion

- Edited records are re-parsed and replace the previous reducer entry.
- Deleted Telegram messages remove the corresponding local record.
- Tool side effects are never automatically rolled back after message deletion.
- Completed tool calls retain a local replay-protection entry.

## 8. Client-side LLM transport

### 8.1 Requirements

- Direct browser request to the user-configured OpenAI-compatible endpoint.
- Streaming support.
- Abort support.
- Configurable base URL and model.
- No silent model remapping.
- Clear CORS and network diagnostics.
- Keys never written to Telegram messages, logs, crash reports, or analytics.

### 8.2 Secret storage

API credentials should use the strongest practical client-side storage available in the application context. At minimum:

- separate secret values from synchronized Telegram records;
- do not embed secrets in Redux debug state or exported settings;
- redact authorization headers from errors;
- provide an explicit “forget key” action;
- support per-device configuration because keys are not synchronized through Telegram.

### 8.3 Long-running requests

Since no application server owns jobs, the client must:

- keep an active request controller;
- persist a lightweight pending-run record locally;
- write final output only when available;
- allow cancellation;
- recover interrupted runs as `aborted` rather than pretending they completed;
- avoid duplicate completion after reload through run IDs and replay protection.

## 9. Telegram tool runtime

### 9.1 Read-only tools for the first milestone

- `get_current_chat`
- `get_messages`
- `get_message_thread`
- `search_messages`
- `get_chat_members`
- `get_user_profile`
- `get_chat_media`
- `get_unread_context`
- `read_attachment_metadata`
- `transcribe_voice` when a local or directly configured endpoint is available

### 9.2 Draft-only capability

- `draft_message`

This produces text in the sidebar or Telegram compose box but does not send it.

### 9.3 Deferred mutating tools

- send message;
- reply;
- edit;
- delete;
- forward;
- pin;
- mark as read;
- create poll;
- send file;
- change group settings.

Every mutating tool requires explicit interactive confirmation at execution time.

### 9.4 Tool contract

```json
{
  "toolCallId": "uuid",
  "runId": "uuid",
  "name": "get_messages",
  "arguments": {},
  "sourcePeerId": "telegram-peer-id",
  "sourceThreadId": null,
  "requestedAt": "ISO-8601"
}
```

The model output is only a proposal. The local runtime validates the tool name, schema, active account, active source chat, permissions, limits, and confirmation policy.

## 10. Security model

### 10.1 Trust boundaries

Untrusted inputs include:

- all Telegram messages;
- all workspace envelopes;
- all LLM responses;
- tool arguments proposed by the model;
- attachment content;
- imported or forwarded messages;
- model endpoint errors.

Trusted components are limited to audited client code, the authenticated Telegram session, and explicit user actions.

### 10.2 Mandatory controls

- strict allowlist of tools;
- strict runtime schemas;
- maximum message, file, token, and pagination limits;
- explicit confirmation for mutations;
- no execution during history replay;
- replay protection using run IDs and tool call IDs;
- source chat binding for every call;
- permission checks at execution time;
- cancellation and timeout handling;
- secret redaction;
- no `eval`, dynamic imports, shell access, or arbitrary HTTP tools;
- no hidden sending of messages.

### 10.3 Privacy behavior

The client must show which model endpoint will receive selected context before the first request. Context collection should default to the minimum required messages and files.

## 11. UI design

### 11.1 Sidebar states

- closed;
- discovering workspace;
- creating workspace;
- loading topic;
- ready;
- streaming;
- awaiting tool confirmation;
- error;
- offline;
- unsupported endpoint/CORS failure.

### 11.2 Message rendering

- `U`: user bubble;
- `A`: assistant bubble with streaming state;
- `C`: tool proposal card;
- `R`: collapsible tool result card;
- `M`: normally hidden;
- `S`: compact status line;
- malformed records: plain Telegram message.

### 11.3 Service group visibility

The custom client filters the workspace peer from:

- main dialog list;
- archived dialog list;
- ordinary global search results;
- unread counters and notification surfaces.

A diagnostic settings page must provide:

- workspace peer ID;
- open raw workspace;
- rebuild topic index;
- export protocol diagnostics without secrets;
- detach or delete workspace after explicit confirmation.

## 12. State management

Separate four state categories:

1. synchronized Telegram records;
2. derived conversation state;
3. local runtime state such as streaming and confirmations;
4. device-local secrets and endpoint settings.

Do not store derived message arrays as a second authoritative database. They should be reproducible from topic history plus bounded local caches.

## 13. Failure handling

- Workspace creation fails: show retry and retain no false mapping.
- Topic creation races across devices: detect duplicate metadata and choose one canonical topic; mark the other as orphaned.
- Endpoint rejects CORS: show actionable local error without server fallback.
- Device closes during streaming: mark the local run interrupted; do not invent a final assistant record.
- Telegram send fails after model completion: retain unsynchronized output locally and offer retry.
- Corrupt envelope: display as plain text and log a bounded diagnostic.
- Missing workspace: rediscover before creating a new one.
- Deleted workspace: allow recreation and start a new workspace ID.

## 14. Testing strategy

### 14.1 Unit tests

- envelope encode/decode;
- malformed and unknown versions;
- Unicode normalization;
- reducer replay;
- duplicate IDs;
- edited/deleted messages;
- topic mapping;
- tool schema validation;
- permission and confirmation policy;
- secret redaction.

### 14.2 Integration tests

- create workspace and forum;
- archive and mute;
- create and discover topic;
- cross-device reconstruction;
- streaming model response;
- interrupted run;
- duplicate topic race;
- message edit/delete synchronization;
- hidden workspace filtering;
- direct endpoint CORS errors.

### 14.3 Security tests

- forged tool-call marker;
- prompt injection in source messages;
- replayed tool call;
- oversized payload;
- malicious attachment metadata;
- endpoint error containing authorization headers;
- account switch while confirmation dialog is open;
- topic mapped to the wrong source chat.

## 15. Delivery plan

### Milestone 0 — protocol spike

- verify MTProto support for creating private forum supergroups and topics;
- test archive and permanent mute behavior;
- test candidate magic prefixes across clients;
- validate direct endpoint calls and CORS constraints;
- produce a minimal topic parser fixture.

Exit criterion: all foundational assumptions validated in a disposable branch.

### Milestone 1 — workspace and sidebar skeleton

- workspace discovery and creation;
- archive, mute, and UI filtering;
- topic mapping;
- right-side panel shell;
- raw text user/assistant records;
- cross-device reconstruction.

Exit criterion: two devices can exchange and render marked user/assistant records through Telegram only.

### Milestone 2 — direct LLM chat

- local endpoint settings;
- direct streaming transport;
- cancellation;
- final assistant record persistence;
- interrupted-run recovery;
- privacy disclosure and context preview.

Exit criterion: no application server sees prompts, keys, or responses.

### Milestone 3 — read-only tools

- tool registry and schemas;
- current-chat context;
- message search and retrieval;
- tool cards and results;
- replay protection;
- prompt-injection defenses.

Exit criterion: read-only tools work without side effects and survive history replay safely.

### Milestone 4 — drafts and confirmations

- draft generation;
- compose-box insertion;
- confirmation framework;
- permission checks;
- first carefully selected mutating action, disabled by default.

Exit criterion: no mutation occurs without a fresh explicit user action.

### Milestone 5 — hardening and release

- performance optimization;
- large-topic pagination;
- accessibility;
- diagnostics;
- migration/versioning tests;
- security review;
- release documentation.

## 16. Parallel workstreams

The following streams can proceed in parallel after Milestone 0 defines stable interfaces.

### Stream A — Telegram workspace lifecycle

Owns supergroup creation, forum enablement, mute/archive behavior, workspace discovery, topic creation, duplicate-race handling, and raw MTProto integration tests.

Depends on: protocol identifiers and metadata schema.

### Stream B — envelope protocol and reducer

Owns message framing, schemas, codec, parser, reducer, edit/delete behavior, replay protection, fixtures, and protocol versioning.

Depends on: no UI code.

### Stream C — sidebar UX

Owns right panel layout, responsive behavior, message cards, streaming presentation, tool cards, errors, loading states, and accessibility.

Depends on: stable view models from Stream B.

### Stream D — local LLM transport and secrets

Owns OpenAI-compatible direct transport, streaming, abort, endpoint configuration, CORS diagnostics, local credential storage, and redaction.

Depends on: run-state interface shared with Stream B and C.

### Stream E — Telegram tool runtime

Owns typed tool registry, read-only tools, permission checks, limits, confirmation API, and local execution adapters.

Depends on: source-chat context contract and protocol record types.

### Stream F — privacy and security verification

Owns threat model, prompt-injection tests, replay tests, secret leakage checks, account-switch races, malformed-record fuzzing, and mutation review.

Depends on all streams but begins during interface design.

### Stream G — integration, CI, and release

Owns end-to-end fixtures, browser tests, multi-device scenarios, feature flags, build validation, documentation, and release packaging.

Depends on incremental deliverables from all streams.

## 17. AI agent team

A practical implementation team uses one coordinating agent and six specialist agents.

### 17.1 Lead architect / integrator

Responsibilities:

- owns this SDD and interface contracts;
- divides work into mergeable slices;
- reviews architecture changes;
- resolves cross-stream conflicts;
- runs final integration and release checks;
- prevents accidental server-side data paths.

This agent is the only agent allowed to change shared cross-cutting interfaces without an explicit design note.

### 17.2 Telegram protocol agent

Scope:

- MTProto calls;
- supergroup/forum lifecycle;
- archive and mute behavior;
- dialog filtering;
- topic mapping and race handling.

Deliverables:

- workspace service;
- topic registry adapter;
- Telegram integration tests.

### 17.3 Protocol/state agent

Scope:

- envelope specification;
- TypeScript schemas;
- codec and parser;
- reducer and replay protection;
- migration/versioning framework.

Deliverables:

- protocol package;
- fixtures;
- unit and fuzz tests.

### 17.4 UI agent

Scope:

- right-side panel;
- message rendering;
- tool cards;
- loading/error states;
- responsive and accessible behavior.

Deliverables:

- isolated Storybook-like fixtures or local component demos;
- production UI integration.

### 17.5 LLM transport agent

Scope:

- direct OpenAI-compatible transport;
- streaming and cancellation;
- endpoint settings;
- secret handling;
- CORS/network diagnostics.

Deliverables:

- transport adapter;
- secure settings module;
- mocked integration tests.

### 17.6 Tool runtime agent

Scope:

- tool registry;
- read-only Telegram tools;
- policy validation;
- limits;
- confirmation mechanism;
- tool result normalization.

Deliverables:

- typed tool API;
- local execution adapters;
- policy tests.

### 17.7 Security/test agent

Scope:

- threat model;
- adversarial records;
- prompt injection;
- replay and race testing;
- secret-leak audits;
- end-to-end and release gates.

Deliverables:

- security test suite;
- release checklist;
- blocking findings with reproductions.

## 18. Agent coordination rules

- Each agent works in a separate branch or worktree.
- Shared contracts live under a small dedicated module and are reviewed by the lead.
- No agent modifies generated `dist` files as source work.
- Every change includes tests relevant to its stream.
- No agent introduces a new server endpoint for prompts, keys, chat history, tools, or AI state.
- Any mutation-capable tool is disabled until reviewed by the security agent and lead.
- Commits remain small and scoped to one stream.
- Integration happens continuously behind a feature flag, not as one final large merge.

## 19. Recommended initial parallel split

Start four agents immediately after the protocol spike:

1. Telegram protocol agent: disposable workspace/forum proof of concept.
2. Protocol/state agent: envelope v1, fixtures, parser, and reducer.
3. UI agent: sidebar shell using mocked view models.
4. LLM transport agent: direct streaming adapter and client-only secret handling.

Then start:

5. Tool runtime agent once the run and record contracts stabilize.
6. Security/test agent from the first integration branch onward.

The lead architect continuously integrates all branches behind one disabled-by-default feature flag.

## 20. Definition of done

The feature is complete when:

- the service supergroup is created, muted, archived, and hidden by the custom client;
- one topic can be resolved for the current source chat;
- a second device reconstructs the same AI conversation from Telegram history;
- prompts and responses travel only between the client, Telegram, and the configured model endpoint;
- no application server stores or receives private AI data;
- malformed or forged markers cannot trigger a tool;
- read-only tools work through the authenticated local Telegram session;
- every mutation requires explicit confirmation;
- API keys are never synchronized through Telegram;
- unit, integration, security, and build checks pass;
- rollback is possible by disabling the feature flag without affecting normal Telegram usage.
