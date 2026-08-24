import { describe, expect, it } from 'vitest';

import type { AccountInfo } from '../../types';

import {
  getNewAccountLoginUrlIfAvailable,
  pickFirstFreeAccountSlot,
} from '../accountSlotPolicy';

function makeAccount(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    userId: 'user-1',
    firstName: 'Test',
    ...overrides,
  };
}

describe('accountSlotPolicy', () => {
  describe('pickFirstFreeAccountSlot', () => {
    it('returns 1 for an empty registry', () => {
      expect(pickFirstFreeAccountSlot({})).toBe(1);
    });

    it('returns the first unused slot when slot 1 is occupied', () => {
      expect(pickFirstFreeAccountSlot({ 1: makeAccount() })).toBe(2);
    });

    it('walks past contiguous occupied slots with no cap', () => {
      expect(pickFirstFreeAccountSlot({
        1: makeAccount(),
        2: makeAccount(),
        3: makeAccount(),
        4: makeAccount(),
      })).toBe(5);
    });

    it('fills holes in a sparse registry', () => {
      expect(pickFirstFreeAccountSlot({
        1: makeAccount(),
        3: makeAccount(),
        5: makeAccount(),
      })).toBe(2);
    });
  });

  describe('getNewAccountLoginUrlIfAvailable', () => {
    it('returns undefined when the registry is undefined', () => {
      expect(getNewAccountLoginUrlIfAvailable(undefined)).toBeUndefined();
    });

    it('returns undefined when the registry is empty (no accounts to add to)', () => {
      expect(getNewAccountLoginUrlIfAvailable({})).toBeUndefined();
    });

    it('returns a login-hash URL that points at the first free slot', () => {
      const url = getNewAccountLoginUrlIfAvailable({ 1: makeAccount() });
      expect(typeof url).toBe('string');
      expect(url).toContain('#login');
      expect(url).toContain('account=2');
    });
  });
});
