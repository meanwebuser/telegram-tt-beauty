# Client-only AI Sidebar Implementation Progress

**Branch:** `feature/client-only-ai-sidebar`
**Base Branch:** `external-transcription`
**Started:** 2026-07-11
**Status:** In Progress - Milestone 0

## Design Decisions

### Architecture
- Client-only approach: No bot, no application server
- Private supergroup with forum mode as storage layer
- Telegram cloud history as cross-device sync
- Envelope protocol with versioned markers for message types
- Direct OpenAI-compatible endpoint calls from browser

### Tech Stack
- TypeScript/TSX with Teact (existing framework)
- SCSS modules for styling
- Global state management (existing patterns)
- Fetch API with AbortController for streaming
- Local Telegram tool execution

---

## Work Completed

### Setup Phase
- [x] Read and analyzed SDD (`docs/sdd/client-only-ai-sidebar-sdd.md`)
- [x] Read workspace architecture (`docs/client-only-ai-workspace.md`)
- [x] Explored repository structure
- [x] Created progress tracking document
- [x] Entered worktree for isolated development

### Milestone 0: Workspace Discovery (In Progress)

#### 0.1: Service Supergroup Creation
- [ ] Add workspace creation logic in `src/global/actions/workspace.ts`
- [ ] Implement supergroup creation via Telegram API
- [ ] Enable forum mode on created supergroup
- [ ] Archive and mute the service group
- [ ] Store workspace metadata in global state

#### 0.2: Topic Management
- [ ] Implement topic creation for new AI sessions
- [ ] Add topic discovery logic (find existing topic for chat)
- [ ] Store topic-to-source-chat mapping
- [ ] Implement topic metadata records

#### 0.3: Topic History Parsing
- [ ] Add envelope parser in `src/global/reducers/envelopeParser.ts`
- [ ] Parse Telegram messages into structured records
- [ ] Handle unknown/malformed envelopes gracefully
- [ ] Implement version compatibility check

#### 0.4: Feature Flag
- [ ] Add `isAiSidebarEnabled` to feature flags
- [ ] Gate all AI sidebar functionality behind flag
- [ ] Add UI toggle in settings (future)

---

## Blockers

None currently.

---

## Next Actions

1. Implement Milestone 0.1: Service Supergroup Creation
2. Validate Telegram API calls for supergroup creation
3. Test forum mode enablement
4. Implement topic discovery logic

---

## Implementation Log

### 2026-07-11 (Session 1)
- **Commit 9d5a3a0**: Milestone 0: Workspace Discovery and Envelope Protocol
- **Commit 10f4e0c**: Integrate sidebar into right column + UI actions
- **Commit f9bb375**: Milestone 1.1: Direct LLM Transport
- **Commit d041d5c**: Envelope protocol, records, and parser (protocol-state agent)
- **Commit 0feccf7**: Consolidate agent work: reducers, actions, serializer
- **Commit 36290fd**: Add AI workspace selectors export + sendAiPrompt action
- **Commit fdfede2**: Wire sendAiPrompt action to LLM transport

### Files Created
- `src/global/types/envelopeProtocol.ts` — Protocol constants
- `src/global/types/envelopeRecords.ts` — Record type definitions
- `src/global/reducers/envelopeParser.ts` — Secure envelope parser
- `src/global/reducers/envelopeSerializer.ts` — Envelope serializer
- `src/global/reducers/aiWorkspace.ts` — Workspace reducers
- `src/global/types/aiWorkspace.ts` — Workspace state types
- `src/global/selectors/aiWorkspace.ts` — Workspace selectors
- `src/global/actions/api/aiWorkspace.ts` — Workspace API actions
- `src/api/gramjs/methods/workspace.ts` — Telegram API methods
- `src/global/llm/transport.ts` — OpenAI-compatible transport
- `src/global/llm/index.ts` — LLM module index
- `src/components/right/AiSidebar.tsx` — Sidebar UI component
- `src/components/right/AiSidebar.module.scss` — Sidebar styles
- `docs/sdd/client-only-ai-sidebar-progress.md` — This file

---

## Notes

- Must keep all work behind feature flag
- Do not modify generated dist artifacts
- Run `npm run check:ts` after TypeScript changes
- Run `npm run check:css` after SCSS changes