/**
 * Envelope protocol constants used to embed AI conversation records inside
 * ordinary Telegram text messages.
 *
 * Each record is encoded as:
 *
 *   PREFIX + VERSION_MARKER + TYPE_MARKER + '\n' + JSON_PAYLOAD
 *
 * The client must treat any Telegram message content as untrusted input,
 * even when it originates from the user's own workspace group. Every byte
 * after the markers is validated, not assumed.
 */

// Reserved Unicode Private Use Area codepoint chosen for its extremely low
// probability of occurrence in natural user-generated text. Three repetitions
// reduce the chance of a single transcription/edit accidentally producing it.
export const ENVELOPE_PREFIX = '';

// Bumped whenever a breaking change is introduced. Records carrying a
// higher major version are rejected and rendered as plain messages.
export const ENVELOPE_VERSION = 1;

// Supported major versions. Unknown major versions are rejected.
export const SUPPORTED_ENVELOPE_VERSIONS: readonly number[] = [1];

export const ENVELOPE_VERSION_MARKER = 'v1';
export const ENVELOPE_FIELD_SEPARATOR = '\n';

// Type markers occupy a single ASCII character so the prefix remains short
// and the chance of collision with normal text is minimized.
export const ENVELOPE_TYPE_USER_PROMPT = 'U';
export const ENVELOPE_TYPE_ASSISTANT_RESPONSE = 'A';
export const ENVELOPE_TYPE_TOOL_CALL = 'T';
export const ENVELOPE_TYPE_TOOL_RESULT = 'R';
export const ENVELOPE_TYPE_SESSION_METADATA = 'M';

export const ENVELOPE_TYPE_MARKERS = {
  userPrompt: ENVELOPE_TYPE_USER_PROMPT,
  assistantResponse: ENVELOPE_TYPE_ASSISTANT_RESPONSE,
  toolCall: ENVELOPE_TYPE_TOOL_CALL,
  toolResult: ENVELOPE_TYPE_TOOL_RESULT,
  sessionMetadata: ENVELOPE_TYPE_SESSION_METADATA,
} as const;

export type EnvelopeTypeMarker = typeof ENVELOPE_TYPE_MARKERS[keyof typeof ENVELOPE_TYPE_MARKERS];

// Reasonable upper bound for a single record. The protocol must never embed
// multi-megabyte blobs into Telegram text messages, both for storage and for
// parser safety.
export const ENVELOPE_MAX_PAYLOAD_BYTES = 64 * 1024;

// Header tokens that must be stripped from any free-form tool error text
// before it is shown to the user. Keys and bearer tokens are redacted to
// `[REDACTED]` so they never leave the authenticated client.
const SENSITIVE_HEADER_PATTERNS = [
  /(authorization\s*:\s*bearer\s+[^\s,;]+)/gi,
  /(api[_-]?key\s*[:=]\s*[^\s,;]+)/gi,
  /(x-api-key\s*[:=]\s*[^\s,;]+)/gi,
];

export const REDACTED_PLACEHOLDER = '[REDACTED]';

export function getEnvelopeHeader(typeMarker: EnvelopeTypeMarker): string {
  return `${ENVELOPE_PREFIX}${ENVELOPE_VERSION_MARKER}${typeMarker}`;
}

export function redactSensitiveText(input: string): string {
  let result = input;
  for (const pattern of SENSITIVE_HEADER_PATTERNS) {
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return result;
}