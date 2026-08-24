import { createCorrelationId, sha256Hex } from './audit';

export const TELEGRAM_MCP_PROTOCOL_VERSION = '1.0';

export const TELEGRAM_CAPABILITIES = [
  'chats.list',
  'messages.read',
  'messages.send',
  'messages.edit',
  'media.inspect',
  'media.read',
  'media.download',
] as const;

export type TelegramCapability = typeof TELEGRAM_CAPABILITIES[number];

export type TelegramMediaType = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'unknown';

export interface TelegramMediaDescriptor {
  media_id: string;
  type: TelegramMediaType;
  name?: string;
  mime_type?: string;
  size?: number;
  preview_available: boolean;
}

export interface TelegramMediaContent {
  kind: TelegramMediaType;
  preview_data_uri?: string;
  preview_available?: boolean;
  metadata?: Record<string, unknown>;
  transcript?: {
    status: 'available' | 'transcription_unavailable';
    text?: string;
  };
  status?: 'unsupported' | 'unavailable';
}

export interface TelegramMediaDownloadReceipt {
  media_id: string;
  type: TelegramMediaType;
  name?: string;
  mime_type?: string;
  size: number;
  checksum: {
    algorithm: 'sha256';
    value: string;
  };
  receipt: string;
  local_path?: string;
}

export interface TelegramMutationConfirmation {
  draft_id: string;
  evidence_id: string;
  payload_hash: string;
  confirmation_text: string;
}

export interface TelegramMutationDraft {
  draft_id: string;
  action: 'send' | 'edit_message';
  payload_hash: string;
  confirmation_text: string;
  created_at: string;
}

export interface TelegramMutationEvidence {
  evidence_id: string;
  draft_id: string;
  action: 'send' | 'edit_message';
  payload_hash: string;
  actor: string;
  session_id: string;
  harness: string;
  confirmation_text: string;
  ts: string;
  state: 'confirmed' | 'claimed' | 'completed' | 'failed';
  result_receipt?: string;
}

export interface TelegramMutationEvidenceStore {
  append(record: TelegramMutationEvidence): Promise<void>;
  read(evidenceId: string): Promise<TelegramMutationEvidence | undefined>;
}

interface StorageLike {
  getItem(key: string): string | undefined | null;
  setItem(key: string, value: string): void;
}

const EVIDENCE_STORAGE_PREFIX = 'telegram-mcp-evidence:';

export function createMemoryMutationEvidenceStore(): TelegramMutationEvidenceStore {
  const records = new Map<string, TelegramMutationEvidence>();
  return {
    append: (record) => Promise.resolve().then(() => {
      records.set(record.evidence_id, record);
    }),
    read: (evidenceId) => Promise.resolve(records.get(evidenceId)),
  };
}

export function createDurableMutationEvidenceStore(): TelegramMutationEvidenceStore {
  let storage: StorageLike | undefined;
  try {
    const candidate = globalThis.localStorage;
    if (candidate) {
      storage = candidate;
    }
  } catch {
    storage = undefined;
  }

  if (!storage) return createMemoryMutationEvidenceStore();

  return {
    append: (record) => Promise.resolve().then(() => {
      const key = `${EVIDENCE_STORAGE_PREFIX}${record.evidence_id}`;
      const historyKey = `${key}:history`;
      const previous = storage.getItem(historyKey);
      const history = previous ? JSON.parse(previous) as TelegramMutationEvidence[] : [];
      history.push(record);
      storage.setItem(historyKey, JSON.stringify(history));
      storage.setItem(key, JSON.stringify(record));
    }),
    read: (evidenceId) => Promise.resolve().then(() => {
      const value = storage.getItem(`${EVIDENCE_STORAGE_PREFIX}${evidenceId}`);
      return value ? JSON.parse(value) as TelegramMutationEvidence : undefined;
    }),
  };
}

export function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export async function hashPayload(value: unknown): Promise<string> {
  const hash = await sha256Hex(stableJson(value));
  if (!hash) throw new Error('SHA-256 is unavailable');
  return hash;
}

export async function hashBytes(value: Uint8Array): Promise<string> {
  const buffer = value.slice().buffer;
  const digest = await globalThis.crypto?.subtle?.digest('SHA-256', buffer);
  if (!digest) throw new Error('SHA-256 is unavailable');
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isTelegramCapability(value: string): value is TelegramCapability {
  return (TELEGRAM_CAPABILITIES as readonly string[]).includes(value);
}

export function negotiateTelegramCapabilities(
  supported: readonly TelegramCapability[],
  requested?: readonly string[],
) {
  const available = Array.from(new Set(supported));
  const wanted = requested?.filter(isTelegramCapability);
  const unsupported = wanted
    ? requested!.filter((capability) => !available.includes(capability as TelegramCapability))
    : [];
  return {
    protocol_version: TELEGRAM_MCP_PROTOCOL_VERSION,
    supported: wanted ? wanted.filter((capability) => available.includes(capability)) : available,
    unsupported,
  };
}

export function createMutationConfirmationText(action: TelegramMutationDraft['action'], payloadHash: string) {
  return `Confirm Telegram ${action} payload ${payloadHash}`;
}

export function createMutationEvidenceId() {
  return `evidence-${createCorrelationId()}`;
}
