# Client-only AI workspace

## Decision

The Telegram Web client owns the entire AI workflow.

- No bot participates in the workspace.
- No application server stores private chats, AI history, API keys, tool calls, or workspace state.
- The browser/client calls the configured OpenAI-compatible endpoint directly.
- The client creates and manages a private Telegram supergroup with forum mode enabled.
- One forum topic is mapped to each source chat or AI session.
- Opening the AI button for a chat renders the matching forum topic in the right sidebar.
- Telegram cloud history is the cross-device synchronization layer.

## Message protocol

Workspace messages use a reserved Unicode prefix followed by a compact versioned type marker.
The prefix must be highly unlikely to occur naturally, but the parser must still validate the
full envelope rather than trusting one character alone.

Initial logical record types:

- user prompt;
- assistant text response;
- tool call;
- tool result;
- system/session metadata.

Human-readable text remains ordinary Telegram message text after the envelope. Unknown versions
or malformed records are displayed as normal messages and never executed.

## Security rules

- API keys remain in client-side protected settings and are never posted to Telegram.
- Tool execution happens only in the authenticated Telegram client.
- Mutating actions require explicit user confirmation.
- Parsed Telegram messages are untrusted input: no marker can authorize an action by itself.
- Tool records use strict schemas, IDs, versioning, and replay protection.
- The client must never send source chat history to an application server.

## Recovery

A fresh device discovers the workspace supergroup, maps topics to source peers using versioned
metadata records, parses topic history, and reconstructs the sidebar conversation locally.
