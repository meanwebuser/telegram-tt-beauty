/**
 * Envelope parser for AI workspace records embedded in Telegram messages.
 *
 * The parser is intentionally side-effect free: it never executes tools,
 * never contacts Telegram, and never reads from global state. It returns
 * either a strongly typed record or `undefined`; the caller decides how to
 * render a failed parse (typically as a regular Telegram message).
 */

import type { ApiMessage } from '../../api/types';
import { TELEGRAM_TOOL_NAMES } from '../../mcp/telegramTools';
import type {
  AiAssistantResponseRecord,
  AiMessageRecord,
  AiSessionMetadataRecord,
  AiToolCallRecord,
  AiToolResultRecord,
  AiUserPromptRecord,
} from '../types/envelopeRecords';
import {
  ENVELOPE_FIELD_SEPARATOR, ENVELOPE_MAX_PAYLOAD_BYTES, ENVELOPE_PREFIX,
  ENVELOPE_TYPE_ASSISTANT_RESPONSE, ENVELOPE_TYPE_SESSION_METADATA,
  ENVELOPE_TYPE_TOOL_CALL, ENVELOPE_TYPE_TOOL_RESULT, ENVELOPE_TYPE_USER_PROMPT,
  SUPPORTED_ENVELOPE_VERSIONS, redactSensitiveText,
} from '../types/envelopeProtocol';

type EnvelopeResult =
  | { record: AiMessageRecord; rawText: string }
  | undefined;

const HEADER_PATTERN = new RegExp(
  `^${escapeForRegExp(ENVELOPE_PREFIX)}([A-Za-z0-9._-]+)([UATRM])$`,
);

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractEnvelopeText(message: ApiMessage): string | undefined {
  const { content } = message;
  if (!content) return undefined;
  if (content.text) {
    return content.text.text;
  }
  return undefined;
}

function parseVersionMarker(versionText: string): number | undefined {
  const match = /^v(\d+)$/.exec(versionText);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSupportedVersion(version: number): boolean {
  return SUPPORTED_ENVELOPE_VERSIONS.includes(version);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function requireString(value: unknown, field: string): string | undefined {
  if (!isNonEmptyString(value)) return undefined;
  return value;
}

function parseHeader(text: string): {
  version: number;
  typeMarker: AiMessageRecord['type'];
  payload: string;
} | undefined {
  const newlineIndex = text.indexOf(ENVELOPE_FIELD_SEPARATOR);
  if (newlineIndex === -1) return undefined;

  const header = text.slice(0, newlineIndex);
  const payload = text.slice(newlineIndex + ENVELOPE_FIELD_SEPARATOR.length);
  if (payload.length === 0 || payload.length > ENVELOPE_MAX_PAYLOAD_BYTES) return undefined;

  const match = HEADER_PATTERN.exec(header);
  if (!match) return undefined;

  const version = parseVersionMarker(match[1]);
  if (version === undefined || !isSupportedVersion(version)) return undefined;

  return { version, typeMarker: match[2] as AiMessageRecord['type'], payload };
}

function parseJsonPayload<T extends object>(payload: string): T | undefined {
  if (payload.length > ENVELOPE_MAX_PAYLOAD_BYTES) return undefined;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as T;
  } catch {
    return undefined;
  }
}

function buildCommonHeader(
  raw: Record<string, unknown>,
  message: ApiMessage,
  typeMarker: AiMessageRecord['type'],
): {
  schema: number;
  sequenceId: number;
  sessionId: string;
} | undefined {
  const schema = parseFiniteNumber(raw.schema);
  const sequenceId = parseFiniteNumber(raw.sequenceId);
  const sessionId = requireString(raw.sessionId, 'sessionId');
  if (schema === undefined || sequenceId === undefined || !sessionId) return undefined;
  if (schema < 1) return undefined;
  if (sequenceId < 0) return undefined;

  // Cross-check the declared type marker against the JSON body.
  if (raw.kind !== typeMarker && raw.type !== typeMarker) return undefined;

  return { schema, sequenceId, sessionId };
}

function buildEnvelopeBase(message: ApiMessage, raw: Record<string, unknown>, typeMarker: AiMessageRecord['type']) {
  const common = buildCommonHeader(raw, message, typeMarker);
  if (!common) return undefined;
  return {
    ...common,
    type: typeMarker,
    messageId: message.id,
    workspaceChatId: message.chatId,
    // workspaceTopicId is filled in by the caller once the forum topic id is
    // resolved from the surrounding message list. The parser itself cannot
    // determine it from a bare ApiMessage.
    workspaceTopicId: 0,
    authorId: message.senderId ?? '',
    sentAt: message.date * 1000,
  };
}

function parseSessionMetadata(message: ApiMessage, raw: Record<string, unknown>): AiSessionMetadataRecord | undefined {
  const base = buildEnvelopeBase(message, raw, ENVELOPE_TYPE_SESSION_METADATA);
  if (!base) return undefined;

  const sourceAccountId = requireString(raw.sourceAccountId, 'sourceAccountId');
  const sourcePeerId = requireString(raw.sourcePeerId, 'sourcePeerId');
  const createdAt = requireString(raw.createdAt, 'createdAt');
  if (!sourceAccountId || !sourcePeerId || !createdAt) return undefined;

  const sourceThreadId = raw.sourceThreadId === null || raw.sourceThreadId === undefined
    ? null
    : parseFiniteNumber(raw.sourceThreadId);

  return {
    ...base,
    type: ENVELOPE_TYPE_SESSION_METADATA,
    sourceAccountId,
    sourcePeerId,
    sourceThreadId: sourceThreadId ?? null,
    createdAt,
    titleSnapshot: isNonEmptyString(raw.titleSnapshot) ? raw.titleSnapshot : undefined,
  };
}

function parseUserPrompt(message: ApiMessage, raw: Record<string, unknown>): AiUserPromptRecord | undefined {
  const base = buildEnvelopeBase(message, raw, ENVELOPE_TYPE_USER_PROMPT);
  if (!base) return undefined;
  const text = requireString(raw.text, 'text');
  if (!text) return undefined;

  const attachedMessageIds = Array.isArray(raw.attachedMessageIds)
    ? raw.attachedMessageIds.filter(parseFiniteNumber).filter((n): n is number => n !== undefined)
    : undefined;

  return {
    ...base,
    type: ENVELOPE_TYPE_USER_PROMPT,
    text,
    requestedModel: isNonEmptyString(raw.requestedModel) ? raw.requestedModel : undefined,
    attachedMessageIds,
  };
}

function parseAssistantResponse(message: ApiMessage, raw: Record<string, unknown>): AiAssistantResponseRecord | undefined {
  const base = buildEnvelopeBase(message, raw, ENVELOPE_TYPE_ASSISTANT_RESPONSE);
  if (!base) return undefined;
  const text = requireString(raw.text, 'text');
  const model = requireString(raw.model, 'model');
  if (!text || !model) return undefined;

  const usage = raw.usage && typeof raw.usage === 'object'
    ? {
      promptTokens: parseFiniteNumber((raw.usage as Record<string, unknown>).promptTokens),
      completionTokens: parseFiniteNumber((raw.usage as Record<string, unknown>).completionTokens),
      totalTokens: parseFiniteNumber((raw.usage as Record<string, unknown>).totalTokens),
    }
    : undefined;

  return {
    ...base,
    type: ENVELOPE_TYPE_ASSISTANT_RESPONSE,
    text: redactSensitiveText(text),
    model,
    isFinal: raw.isFinal === true,
    usage,
    editOfMessageId: parseFiniteNumber(raw.editOfMessageId),
  };
}

function parseToolCall(message: ApiMessage, raw: Record<string, unknown>): AiToolCallRecord | undefined {
  const base = buildEnvelopeBase(message, raw, ENVELOPE_TYPE_TOOL_CALL);
  if (!base) return undefined;
  const callId = requireString(raw.callId, 'callId');
  const toolName = requireString(raw.toolName, 'toolName');
  const argumentsRaw = raw.arguments === undefined ? '' : (raw.arguments as string);
  if (!callId || !toolName || typeof argumentsRaw !== 'string') return undefined;
  if (!TELEGRAM_TOOL_NAMES.includes(toolName as (typeof TELEGRAM_TOOL_NAMES)[number])) return undefined;
  if (argumentsRaw.length > ENVELOPE_MAX_PAYLOAD_BYTES) return undefined;

  return {
    ...base,
    type: ENVELOPE_TYPE_TOOL_CALL,
    callId,
    toolName,
    argumentsJson: argumentsRaw,
  };
}

function parseToolResult(message: ApiMessage, raw: Record<string, unknown>): AiToolResultRecord | undefined {
  const base = buildEnvelopeBase(message, raw, ENVELOPE_TYPE_TOOL_RESULT);
  if (!base) return undefined;
  const callId = requireString(raw.callId, 'callId');
  if (!callId) return undefined;
  const status = raw.status;
  if (status !== 'ok' && status !== 'error' && status !== 'denied') return undefined;

  const errorMessage = isNonEmptyString(raw.errorMessage) ? redactSensitiveText(raw.errorMessage) : undefined;
  const resultJson = typeof raw.resultJson === 'string'
    ? redactSensitiveText(raw.resultJson)
    : undefined;

  return {
    ...base,
    type: ENVELOPE_TYPE_TOOL_RESULT,
    callId,
    status,
    errorMessage,
    resultJson,
  };
}

function dispatchByType(
  typeMarker: AiMessageRecord['type'],
  message: ApiMessage,
  payload: string,
): AiMessageRecord | undefined {
  const raw = parseJsonPayload<Record<string, unknown>>(payload);
  if (!raw) return undefined;

  switch (typeMarker) {
    case ENVELOPE_TYPE_SESSION_METADATA:
      return parseSessionMetadata(message, raw);
    case ENVELOPE_TYPE_USER_PROMPT:
      return parseUserPrompt(message, raw);
    case ENVELOPE_TYPE_ASSISTANT_RESPONSE:
      return parseAssistantResponse(message, raw);
    case ENVELOPE_TYPE_TOOL_CALL:
      return parseToolCall(message, raw);
    case ENVELOPE_TYPE_TOOL_RESULT:
      return parseToolResult(message, raw);
    default:
      return undefined;
  }
}

/**
 * Parse a Telegram message into an AI workspace envelope record.
 *
 * Returns `undefined` for any input that is not an envelope, has an
 * unsupported version, fails JSON validation, or whose declared type marker
 * does not match the embedded payload. Never throws.
 */
export function parseEnvelopeMessage(message: ApiMessage, workspaceTopicId?: number): EnvelopeResult {
  const text = extractEnvelopeText(message);
  if (!text || !text.startsWith(ENVELOPE_PREFIX)) return undefined;

  const header = parseHeader(text);
  if (!header) return undefined;

  const record = dispatchByType(header.typeMarker, message, header.payload);
  if (!record) return undefined;

  if (workspaceTopicId !== undefined && workspaceTopicId > 0) {
    record.workspaceTopicId = workspaceTopicId;
  }

  return { record, rawText: text };
}

/**
 * Convenience selector: returns the parsed envelope record or `undefined`
 * without exposing the raw text. Useful for selectors and reducers that only
 * care about the typed payload.
 */
export function tryParseEnvelope(message: ApiMessage, workspaceTopicId?: number): AiMessageRecord | undefined {
  return parseEnvelopeMessage(message, workspaceTopicId)?.record;
}
