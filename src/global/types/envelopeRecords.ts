/**
 * Parsed AI workspace envelope record types.
 *
 * Every record shares a common envelope header so the parser can dispatch by
 * type marker, then narrows to one of the concrete shapes below. Records are
 * treated as untrusted data: every field is validated at parse time and the
 * original raw envelope text is preserved for diagnostics.
 */

import type { EnvelopeTypeMarker } from './envelopeProtocol';

interface AiEnvelopeHeader {
  type: EnvelopeTypeMarker;
  schema: number;
  sequenceId: number;
  /** Telegram message id that carried this envelope. */
  messageId: number;
  /** Workspace chat id (the hidden service supergroup). */
  workspaceChatId: string;
  /** Workspace forum topic id. */
  workspaceTopicId: number;
  /** Sender Telegram user id. Always the authenticated user for now. */
  authorId: string;
  /** Wall-clock millisecond timestamp of the source Telegram message. */
  sentAt: number;
}

export interface AiSessionMetadataRecord extends AiEnvelopeHeader {
  type: 'M';
  sessionId: string;
  sourceAccountId: string;
  sourcePeerId: string;
  sourceThreadId: number | null;
  createdAt: string;
  titleSnapshot?: string;
}

export interface AiUserPromptRecord extends AiEnvelopeHeader {
  type: 'U';
  sessionId: string;
  text: string;
  /** Optional model the user explicitly requested. */
  requestedModel?: string;
  /** Attached Telegram message ids providing additional context. */
  attachedMessageIds?: number[];
}

export interface AiAssistantResponseRecord extends AiEnvelopeHeader {
  type: 'A';
  sessionId: string;
  text: string;
  model: string;
  /** True when the response was streamed incrementally and finalized in place. */
  isFinal: boolean;
  /** Token accounting, if reported by the endpoint. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** id of the assistant message that should be edited when more chunks arrive. */
  editOfMessageId?: number;
}

export interface AiToolCallRecord extends AiEnvelopeHeader {
  type: 'T';
  sessionId: string;
  /** Stable identifier used to correlate with the matching ToolResultRecord. */
  callId: string;
  toolName: string;
  /** JSON-encoded arguments object, validated against the tool schema at execution time. */
  argumentsJson: string;
}

export type AiToolResultStatus = 'ok' | 'error' | 'denied';

export interface AiToolResultRecord extends AiEnvelopeHeader {
  type: 'R';
  sessionId: string;
  /** Matches the callId of the originating ToolCallRecord. */
  callId: string;
  status: AiToolResultStatus;
  /** JSON-encoded result payload when status === 'ok'. */
  resultJson?: string;
  /** Human-readable, already-redacted error message when status !== 'ok'. */
  errorMessage?: string;
}

export type AiMessageRecord =
  AiSessionMetadataRecord
  | AiUserPromptRecord
  | AiAssistantResponseRecord
  | AiToolCallRecord
  | AiToolResultRecord;