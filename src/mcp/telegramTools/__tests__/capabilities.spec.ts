import { describe, expect, it, vi } from 'vitest';

import type { ApiChat } from '../../../api/types';

import { createMemoryMutationEvidenceStore } from '../capabilities';
import { createTelegramToolRegistry } from '../index';

const context = {
  transport: 'test',
  harness: 'test',
  actor: 'tester',
  sessionId: 'session-1',
  allowWrite: true,
};

function makeChat(): ApiChat {
  return {
    id: 'chat-1',
    type: 'chatTypeSuperGroup',
    title: 'Test chat',
  };
}

function makeRegistry(content: Record<string, unknown>, downloadMedia = vi.fn(), includeEdit = true) {
  const message = {
    id: 7,
    chatId: 'chat-1',
    date: 1,
    isOutgoing: true,
    content,
  };
  const editMessage = vi.fn().mockResolvedValue(message);
  const registry = createTelegramToolRegistry({
    listChats: vi.fn(),
    resolveChat: vi.fn().mockResolvedValue(makeChat()),
    fetchMessagesById: vi.fn().mockResolvedValue({ messages: [message] }),
    fetchMessages: vi.fn(),
    searchMessages: vi.fn(),
    fetchFullChat: vi.fn(),
    markMessageListRead: vi.fn(),
    markMessagesRead: vi.fn(),
    sendMessage: vi.fn(),
    editMessage: includeEdit ? editMessage : undefined,
    downloadMedia,
  }, { evidenceStore: createMemoryMutationEvidenceStore() });
  return { registry, editMessage, downloadMedia };
}

describe('provider-neutral Telegram media capabilities', () => {
  it.each([
    ['photo', { photo: { mediaType: 'photo', id: 'p1', sizes: [], thumbnail: {
      dataUri: 'data:image/png;base64,AA',
    } } }, 'image'],
    ['video', { video: {
      mediaType: 'video', id: 'v1', mimeType: 'video/mp4', fileName: 'clip.mp4', size: 3, duration: 2,
    } }, 'video'],
    ['audio', { audio: {
      mediaType: 'audio', id: 'a1', mimeType: 'audio/ogg', fileName: 'clip.ogg', size: 3, duration: 2,
    } }, 'audio'],
    ['voice', { voice: { mediaType: 'voice', id: 'vo1', size: 3, duration: 2 } }, 'voice'],
    ['document', { document: {
      mediaType: 'document', id: 'd1', mimeType: 'application/pdf', fileName: 'file.pdf', size: 3,
    } }, 'document'],
    ['unknown', { unknown: { mediaType: 'custom', id: 'u1' } }, 'unknown'],
  ] as const)('normalizes %s media through inspect/read', async (_name, content, expectedType) => {
    const { registry } = makeRegistry(content as Record<string, unknown>);
    const inspected = await registry.execute('media.inspect', { chat_id: 'chat-1', message_id: 7 });
    const read = await registry.execute('media.read', { chat_id: 'chat-1', message_id: 7 });

    expect(inspected).toMatchObject({ ok: true, data: { media: { type: expectedType } } });
    expect(read).toMatchObject({ ok: true, data: { content: { kind: expectedType } } });
    if (expectedType === 'audio' || expectedType === 'voice') {
      expect(read).toMatchObject({ data: { content: { transcript: { status: 'transcription_unavailable' } } } });
    }
  });

  it('returns a bounded checksum receipt and never returns media bytes', async () => {
    const downloadMedia = vi.fn().mockResolvedValue({ arrayBuffer: new Uint8Array([1, 2, 3]) });
    const { registry } = makeRegistry({ document: {
      mediaType: 'document', id: 'd1', mimeType: 'application/pdf', fileName: 'file.pdf',
    } }, downloadMedia);
    const result = await registry.execute('media.download', {
      chat_id: 'chat-1',
      message_id: 7,
      max_bytes: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      data: { media_id: 'chat-1:7:d1', size: 3, checksum: { algorithm: 'sha256' } },
    });
    expect(result).not.toHaveProperty('data.arrayBuffer');
    expect(downloadMedia).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 10 }));
  });

  it('fails closed when provider media download exceeds the negotiated limit', async () => {
    const { registry } = makeRegistry(
      { document: { mediaType: 'document', id: 'd1', mimeType: 'application/pdf' } },
      vi.fn().mockResolvedValue({ data: new Uint8Array([1, 2, 3]) }),
    );
    const result = await registry.execute('media.download', { chat_id: 'chat-1', message_id: 7, max_bytes: 2 });

    expect(result).toMatchObject({ ok: false, error: { code: 'MEDIA_LIMIT_EXCEEDED' } });
  });

  it('negotiates supported and explicit unsupported capabilities', async () => {
    const { registry } = makeRegistry({ photo: { mediaType: 'photo', id: 'p1', sizes: [] } });
    const result = await registry.execute('capabilities', {
      requested: ['media.read', 'messages.edit', 'future.capability'],
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        supported: ['media.read', 'messages.edit'],
        unsupported: ['future.capability'],
      },
    });
  });
});

describe('provider-neutral edit mutation gate', () => {
  it('requires exact evidence, binds payload, and executes once', async () => {
    const { registry, editMessage } = makeRegistry({ photo: { mediaType: 'photo', id: 'p1', sizes: [] } });
    const args = { chat_id: 'chat-1', message_id: 7, caption: 'edited caption' };
    const draftResult = await registry.execute('edit_message', args, context);

    expect(draftResult).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    if (draftResult.ok) return;
    const draft = JSON.parse(draftResult.error.message).draft;
    const evidence = await registry.confirmMutation(draft.draft_id, draft.confirmation_text, context);
    expect(evidence).toMatchObject({ ok: true, data: { payload_hash: draft.payload_hash } });
    if (!evidence.ok) return;

    const confirmed = await registry.execute('edit_message', { ...args, confirmation: evidence.data }, context);
    const replay = await registry.execute('edit_message', { ...args, confirmation: evidence.data }, context);
    const mismatch = await registry.execute('edit_message', {
      ...args,
      caption: 'different',
      confirmation: evidence.data,
    }, context);

    expect(confirmed).toMatchObject({ ok: true, data: { receipt: expect.stringMatching(/^edit-/) } });
    expect(replay).toMatchObject({ ok: false, error: { code: 'REPLAY_DETECTED' } });
    expect(mismatch).toMatchObject({ ok: false, error: { code: 'REPLAY_DETECTED' } });
    expect(editMessage).toHaveBeenCalledTimes(1);
  });

  it('returns explicit unsupported when the provider has no edit operation', async () => {
    const { registry } = makeRegistry({ photo: { mediaType: 'photo', id: 'p1', sizes: [] } }, vi.fn(), false);
    const result = await registry.execute('edit_message', { chat_id: 'chat-1', message_id: 7, text: 'no-op' }, context);

    expect(result).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNSUPPORTED' } });
  });
});
