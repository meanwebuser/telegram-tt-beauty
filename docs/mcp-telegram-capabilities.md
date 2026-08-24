# Telegram MCP capability contract

The MCP surface is provider-neutral. A provider negotiates the versioned
capability set through `capabilities`; clients must handle an explicit
`unsupported` list and must not infer support from a tool name alone.

## Capabilities

The current contract is version `1.0` and defines:

- `chats.list`, `messages.read`, and `messages.send`;
- `messages.edit` through `edit_message`;
- `media.inspect`, `media.read`, and `media.download`.

`media.inspect` and `media.read` accept `chat_id` and `message_id`. Media is
normalized to `image`, `video`, `audio`, `voice`, `document`, or `unknown`.
`media.read` returns bounded metadata and a safe representation: images may
include a bounded preview, videos include metadata and preview availability,
audio/voice returns a transcript when a provider supplies one or the explicit
state `transcription_unavailable`, and documents return metadata only.

`media.download` enforces a byte ceiling before returning to the caller. The
result contains `media_id`, normalized type, name/MIME, size, SHA-256 checksum,
and an opaque receipt. It never returns unbounded binary data, Telegram
credentials, file references, or provider secrets. A provider may attach a
local path, but a receipt remains the portable contract.

## Message editing and evidence gate

`edit_message` requires `chat_id`, `message_id`, and exactly one new `text` or
`caption`. It uses the same mutation gate as `send`:

1. The first call creates a draft containing a canonical payload hash and the
   exact confirmation text.
2. `mutation.confirm` persists the user's exact confirmation in the local
   append-only evidence journal.
3. The edit call must provide the returned evidence. The gate checks payload
   hash, draft/evidence id, actor, harness, session, confirmation text, and
   state before claiming the evidence.
4. A successful or failed provider result appends the terminal receipt/state.

Missing evidence, mismatched payload or confirmation, actor/session mismatch,
and replay after claim all fail closed. The provider is invoked once only
after a successful claim. Providers without edit support return
`CAPABILITY_UNSUPPORTED`; they must not emulate edit with send/delete.

The browser MCP bridge supplies stable actor/session/harness bindings and
does not expose mutation tools when write permission is disabled. The
Telegram adapter performs media downloads through the existing authenticated
`downloadMedia` API and edits through the existing `editMessage` API; no
BrowserOS-only transport is part of this contract.
