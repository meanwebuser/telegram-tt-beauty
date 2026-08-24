export type TelegramAuditEvent =
  | 'mcp_call_start'
  | 'mcp_call_end'
  | 'telegram_send_start'
  | 'telegram_send_end'
  | 'telegram_send_request_start'
  | 'telegram_send_request_end'
  | 'telegram_edit_start'
  | 'telegram_edit_end'
  | 'telegram_media_download_start'
  | 'telegram_media_download_end';

export interface TelegramToolExecutionContext {
  correlationId?: string;
  transport?: string;
  allowWrite?: boolean;
  abortControllerGroup?: string;
  isActive?: () => boolean;
  checkActive?: () => Promise<boolean>;
  actor?: string;
  sessionId?: string;
  harness?: string;
  mutationConfirmation?: import('./capabilities').TelegramMutationConfirmation;
}

export interface TelegramAuditRecord {
  ts: string;
  event: TelegramAuditEvent;
  correlation_id: string;
  transport: string;
  tool?: string;
  chat_id?: string;
  text_sha256?: string;
  text_length?: number;
  ok?: boolean;
  error_code?: string;
  payload_hash?: string;
  actor?: string;
  session_id?: string;
  harness?: string;
}

export type TelegramAuditSink = (record: TelegramAuditRecord) => void | Promise<void>;

function fallbackCorrelationId() {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createCorrelationId() {
  return globalThis.crypto?.randomUUID?.() || fallbackCorrelationId();
}

export async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto?.subtle?.digest('SHA-256', bytes);
  if (!digest) return undefined;
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const consoleAuditSink: TelegramAuditSink = (record) => {
  globalThis.console?.info(`[telegram-mcp-audit] ${JSON.stringify(record)}`);
};

export async function emitTelegramAudit(
  sink: TelegramAuditSink,
  input: Omit<TelegramAuditRecord, 'ts' | 'correlation_id' | 'transport'> & {
    context?: TelegramToolExecutionContext;
    text?: string;
  },
) {
  const { context, text, ...record } = input;
  const correlationId = context?.correlationId || createCorrelationId();
  const textHash = text === undefined ? undefined : await sha256Hex(text);
  await sink({
    ...record,
    ts: new Date().toISOString(),
    correlation_id: correlationId,
    transport: context?.transport || 'unknown',
    ...(textHash ? { text_sha256: textHash } : {}),
    ...(text === undefined ? {} : { text_length: text.length }),
    ...(context?.actor ? { actor: context.actor } : {}),
    ...(context?.sessionId ? { session_id: context.sessionId } : {}),
    ...(context?.harness ? { harness: context.harness } : {}),
  });
  return correlationId;
}
