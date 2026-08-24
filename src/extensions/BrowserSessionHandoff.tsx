import { useEffect, useRef, useState } from '../lib/teact/teact';
import { withGlobal } from '../global';

import type { ApiUser } from '../api/types';
import type { GlobalState } from '../global/types';

import { selectUser } from '../global/selectors';
import { isCurrentTabMaster } from '../util/establishMultitabRole';
import { callApi, callApiLocal } from '../api/gramjs';
import { getNewAccountLoginUrl } from './accountSlotPolicy';
import {
  BROWSER_HANDOFF_AUTO_AUTHORIZE_PREFIX,
  BROWSER_HANDOFF_AUTO_AUTHORIZE_QUERY,
  BROWSER_HANDOFF_CLAIM_PREFIX,
  getBrowserHandoffAutoAuthorizeUrl,
  getBrowserHandoffStorageKey,
} from './browserSessionHandoff';

import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';

type StateProps = {
  authState: GlobalState['auth']['state'];
  currentUser?: ApiUser;
};

const BrowserSessionHandoff = ({ authState, currentUser }: StateProps) => {
  const browserHandoffAttemptedRef = useRef(false);
  const [browserHandoffId, setBrowserHandoffId] = useState<string>();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const finishHandoff = (handoffId: string) => {
    const request = isCurrentTabMaster() ? callApiLocal : callApi;
    void request('authorizeBrowserSession', { handoffId })
      .then((result) => {
        if (result?.redirectUrl) {
          localStorage.removeItem(getBrowserHandoffStorageKey(BROWSER_HANDOFF_AUTO_AUTHORIZE_PREFIX, handoffId));
          sessionStorage.removeItem(getBrowserHandoffStorageKey(BROWSER_HANDOFF_AUTO_AUTHORIZE_PREFIX, handoffId));
          window.location.assign(result.redirectUrl);
          return;
        }

        localStorage.removeItem(getBrowserHandoffStorageKey(BROWSER_HANDOFF_CLAIM_PREFIX, handoffId));
        browserHandoffAttemptedRef.current = false;
        setIsSubmitting(false);
        setError('Не удалось создать серверную сессию Telegram. Попробуйте ещё раз.');
        setIsModalOpen(true);
      })
      .catch((err: unknown) => {
        localStorage.removeItem(getBrowserHandoffStorageKey(BROWSER_HANDOFF_CLAIM_PREFIX, handoffId));
        browserHandoffAttemptedRef.current = false;
        setIsSubmitting(false);
        setError('Не удалось подключить аккаунт Telegram. Проверьте соединение и попробуйте ещё раз.');
        setIsModalOpen(true);
        // eslint-disable-next-line no-console
        console.warn('Telegram browser-session handoff failed', err);
      });
  };

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const handoffId = searchParams.get('handoff_id');
    if (!handoffId || browserHandoffAttemptedRef.current) return;

    setBrowserHandoffId(handoffId);
    const autoAuthorizeKey = getBrowserHandoffStorageKey(BROWSER_HANDOFF_AUTO_AUTHORIZE_PREFIX, handoffId);
    const shouldAutoAuthorize = searchParams.get(BROWSER_HANDOFF_AUTO_AUTHORIZE_QUERY) === '1'
      || sessionStorage.getItem(autoAuthorizeKey) === '1'
      || localStorage.getItem(autoAuthorizeKey) === '1';
    if (shouldAutoAuthorize) {
      if (authState !== 'authorizationStateReady') return;

      sessionStorage.removeItem(autoAuthorizeKey);
      localStorage.removeItem(autoAuthorizeKey);
      browserHandoffAttemptedRef.current = true;
      setIsSubmitting(true);
      finishHandoff(handoffId);
      return;
    }

    if (!localStorage.getItem(getBrowserHandoffStorageKey(BROWSER_HANDOFF_CLAIM_PREFIX, handoffId))) {
      setIsModalOpen(true);
    }
  }, [authState]);

  const handleUseCurrentAccount = () => {
    if (!browserHandoffId || authState !== 'authorizationStateReady') return;

    localStorage.setItem(
      getBrowserHandoffStorageKey(BROWSER_HANDOFF_CLAIM_PREFIX, browserHandoffId),
      'current-account',
    );
    browserHandoffAttemptedRef.current = true;
    setIsSubmitting(true);
    setError(undefined);
    setIsModalOpen(false);
    finishHandoff(browserHandoffId);
  };

  const handleUseNewAccount = () => {
    if (!browserHandoffId) return;

    sessionStorage.setItem(
      getBrowserHandoffStorageKey(BROWSER_HANDOFF_AUTO_AUTHORIZE_PREFIX, browserHandoffId),
      '1',
    );
    localStorage.setItem(
      getBrowserHandoffStorageKey(BROWSER_HANDOFF_AUTO_AUTHORIZE_PREFIX, browserHandoffId),
      '1',
    );
    localStorage.removeItem(getBrowserHandoffStorageKey(BROWSER_HANDOFF_CLAIM_PREFIX, browserHandoffId));
    browserHandoffAttemptedRef.current = true;
    setError(undefined);
    setIsModalOpen(false);
    window.location.assign(getBrowserHandoffAutoAuthorizeUrl(getNewAccountLoginUrl()));
  };

  const activeUsername = currentUser?.usernames?.find((username) => username.isActive)?.username;

  return (
    <Modal
      isOpen={isModalOpen && Boolean(browserHandoffId)}
      title="Подключение Telegram к MCP"
      onClose={() => setIsModalOpen(false)}
      isNativeDialog
      noTitleAutoFocus
    >
      <p>
        Выберите аккаунт, который будет подключён к MCP-серверу:
        {' '}
        <strong>
          {[currentUser?.firstName, currentUser?.lastName].filter(Boolean).join(' ') || 'Telegram'}
        </strong>
        {activeUsername && (
          <>
            {' '}
            (@
            {activeUsername}
            )
          </>
        )}
      </p>
      <p>Для нового аккаунта откроется отдельный вход Telegram.</p>
      {error && <p className="text-danger">{error}</p>}
      <div className="dialog-buttons-column mt-2">
        <Button
          className="confirm-dialog-button"
          isText
          inline
          onClick={handleUseCurrentAccount}
          disabled={authState !== 'authorizationStateReady' || isSubmitting}
          autoFocus={authState === 'authorizationStateReady'}
        >
          Войти в этот аккаунт
        </Button>
        <Button
          className="confirm-dialog-button"
          isText
          inline
          onClick={handleUseNewAccount}
          disabled={isSubmitting}
        >
          Войти в новый аккаунт
        </Button>
      </div>
    </Modal>
  );
};

export default withGlobal((global): Complete<StateProps> => ({
  authState: global.auth.state,
  currentUser: selectUser(global, global.currentUserId!),
}))(BrowserSessionHandoff);
