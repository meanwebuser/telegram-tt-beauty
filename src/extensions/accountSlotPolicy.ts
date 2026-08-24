import type { AccountInfo } from '../types';

import { ACCOUNT_SLOT, getAccountsInfo, getAccountSlotUrl } from '../util/multiaccount';

/**
 * Account-slot policy for the local "add account" affordance.
 *
 * The upstream menu used to compute its own "next free slot" inline. This
 * module isolates that policy so upstream updates can land as a thin call
 * site instead of a manual rewrite of fork-only logic.
 *
 * Current behaviour (no cap, no test bias, login hash):
 *   - empty registry  -> undefined (hide the affordance)
 *   - any registry    -> first free positive integer slot, starting at 1
 *   - slot URL        -> `getAccountSlotUrl(slot, true)` (login hash)
 */

export type AccountRegistry = Record<number, AccountInfo> | undefined;

/**
 * Returns the smallest positive integer slot index that is not already
 * registered in `accounts`, or `undefined` when the registry is empty
 * (i.e. there are no accounts to add a sibling to).
 */
export function pickFirstFreeAccountSlot(accounts: AccountRegistry = getAccountsInfo()): number {
  let freeIndex = 1;
  while (accounts[freeIndex]) {
    freeIndex += 1;
  }
  return freeIndex;
}

/**
 * Builds the login URL for the next free account slot. Mirrors the
 * upstream behaviour: first free slot, login hash, no test bias.
 * Returns `undefined` when no slot is available.
 */
export function getNewAccountLoginUrl(accounts: AccountRegistry = getAccountsInfo()): string {
  return getAccountSlotUrl(pickFirstFreeAccountSlot(accounts), true);
}

/** The upstream menu hides the add-account item until one account exists. */
export function getNewAccountLoginUrlIfAvailable(accounts: AccountRegistry): string | undefined {
  if (!accounts || !Object.values(accounts).length) return undefined;
  return getNewAccountLoginUrl(accounts);
}

/** Return the highest-numbered stored account for first-load recovery. */
export function getStoredAccountRecoveryUrl(hash = 'login') {
  if (ACCOUNT_SLOT) return undefined;

  const accounts = getAccountsInfo();
  const slot = Object.keys(accounts)
    .map(Number)
    .sort((a, b) => b - a)
    .find((candidate) => Boolean(accounts[candidate]));

  return slot ? `${getAccountSlotUrl(slot)}#${hash}` : undefined;
}
