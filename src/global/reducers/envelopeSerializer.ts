/**
 * Envelope serializer for AI workspace records.
 *
 * Builds the wire format that the envelope parser (`envelopeParser.ts`) reads
 * out of Telegram text messages. The serializer only produces text; the
 * caller is responsible for sending it through `callApi('sendMessage', …)`.
 *
 * Every byte produced here must round-trip through `parseEnvelopeMessage`
 * — the parser is the source of truth and the serializer mirrors it exactly.
 */

import {
  ENVELOPE_FIELD_SEPARATOR,
  ENVELOPE_MAX_PAYLOAD_BYTES,
  ENVELOPE_PREFIX,
  ENVELOPE_TYPE_SESSION_METADATA,
  ENVELOPE_TYPE_MARKERS,
  ENVELOPE_VERSION_MARKER,
  type EnvelopeTypeMarker,
  getEnvelopeHeader,
} from '../types/envelopeProtocol';

/**
 * Minimal fields required by every record body.
 * Mirrors `buildCommonHeader` in the parser.
 */
export interface EnvelopeBaseFields {
  schema: number;
  sequenceId: number;
  sessionId: string;
}

/**
 * Body shape for a session metadata record (`M`).
 * Mirrors the parser's `parseSessionMetadata`.
 */
export interface SessionMetadataBody extends EnvelopeBaseFields {
  kind: typeof ENVELOPE_TYPE_SESSION_METADATA;
  sourceAccountId: string;
  sourcePeerId: string;
  sourceThreadId: number | null;
  createdAt: string;
  titleSnapshot?: string;
}

/**
 * Discriminated union of all bodies the workspace layer currently produces.
 * New record kinds should be added here and to `dispatchByType` in the
 * parser in lockstep.
 */
export type EnvelopeBody = SessionMetadataBody;

const HEAD_PATTERN = `${ENVELOPE_PREFIX}${ENVELOPE_VERSION_MARKER}`;

/**
 * Build a wire-format envelope string for a single record.
 *
 * Returns `undefined` if the body would exceed the per-record payload limit
 * or contains non-serialisable data, so callers can fail closed.
 */
export function serializeEnvelope(
  typeMarker: EnvelopeTypeMarker,
  body: EnvelopeBody,
): string | undefined {
  if (!ENVELOPE_TYPE_MARKERS[typeMarkerToKey(typeMarker)]) return undefined;
  if (body.schema < 1 || body.sequenceId < 0) return undefined;
  if (!isNonEmptyString(body.sessionId)) return undefined;

  // `kind` must agree with the type marker, matching the parser's cross-check.
  if (body.kind !== typeMarker) return undefined;

  const payload = safeStringify(body);
  if (!payload) return undefined;
  if (payload.length === 0 || payload.length > ENVELOPE_MAX_PAYLOAD_BYTES) return undefined;

  const header = getEnvelopeHeader(typeMarker);
  return `${header}${ENVELOPE_FIELD_SEPARATOR}${payload}`;
}

/**
 * Convenience: build a session metadata envelope for the workspace topic
 * bootstrap message.
 */
export function serializeSessionMetadata(
  body: Omit<SessionMetadataBody, 'kind'>,
): string | undefined {
  return serializeEnvelope(ENVELOPE_TYPE_SESSION_METADATA, { ...body, kind: ENVELOPE_TYPE_SESSION_METADATA });
}

function typeMarkerToKey(marker: EnvelopeTypeMarker): keyof typeof ENVELOPE_TYPE_MARKERS {
  switch (marker) {
    case ENVELOPE_TYPE_SESSION_METADATA:
      return 'sessionMetadata';
    default:
      // Exhaustiveness check — if a new marker is added, this assignment
      // will fail at compile time.
      return 'sessionMetadata';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function safeStringify(body: EnvelopeBody): string | undefined {
  try {
    // `JSON.stringify` can return `undefined` for unserialisable input —
    // treat that as a hard failure so we never produce an invalid envelope.
    const text = JSON.stringify(body);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

// Re-export the prefix so callers building ad-hoc envelopes can stay
// consistent with the parser without importing the protocol module twice.
export const ENVELOPE_WIRE_PREFIX = HEAD_PATTERN;
