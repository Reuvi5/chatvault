'use client';

/**
 * Client-side vault state.
 *
 * The master key lives here, in memory, for as long as the tab is open and
 * active. It is never written to storage, never sent anywhere, and is zeroed
 * when the vault is locked — by the person, by the idle timer, or by closing the
 * tab. Reloading the page therefore means unlocking again, which is the correct
 * behaviour for an archive whose keys the server cannot hold.
 *
 * Two caches hang off the unlocked key, and both are cleared by locking:
 * ciphertext objects as they were downloaded, and decrypted conversations
 * re-encrypted under the vault's `index` subkey. The second is what makes
 * reopening a large archive quick.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiClient,
  ApiRequestError,
  ArchiveReader,
  createDefaultCache,
  createMessageCache,
  type CiphertextCache,
  type ConversationEntry,
  type MessageCache,
  type SessionInfo,
} from '@chatvault/client';
import {
  createVault as createVaultKeys,
  deriveSubkey,
  lockVault,
  rewrapWithPassphrase,
  rotateRecoveryKey,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  type UnlockedVault,
} from '@chatvault/crypto';
import type { CanonicalMessage } from '@chatvault/parser';

export type VaultStatus = 'loading' | 'signed-out' | 'needs-setup' | 'locked' | 'unlocked';

const IDLE_LOCK_MS = 30 * 60 * 1000;

export interface VaultContextValue {
  status: VaultStatus;
  session: SessionInfo | null;
  vault: UnlockedVault | null;
  reader: ArchiveReader | null;
  api: ApiClient;
  assumedTimeZone: string;
  conversations: ConversationEntry[];
  conversationsLoading: boolean;
  messagesByConversation: Record<string, CanonicalMessage[]>;
  loadProgress: { conversationId: string; done: number; total: number } | null;
  /** Where the last conversation came from, for the interface to mention. */
  lastLoadSource: 'cache' | 'network' | null;
  refreshSession: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  loadMessages: (conversationId: string) => Promise<CanonicalMessage[]>;
  setupVault: (passphrase: string, timeZone: string) => Promise<{ recoveryKeyDisplay: string }>;
  unlock: (secret: string, kind: 'passphrase' | 'recovery') => Promise<void>;
  changePassphrase: (next: string) => Promise<void>;
  newRecoveryKey: () => Promise<string>;
  lock: () => Promise<void>;
  signOut: () => Promise<void>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault(): VaultContextValue {
  const value = useContext(VaultContext);
  if (!value) throw new Error('useVault must be used inside <VaultProvider>');
  return value;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => new ApiClient(), []);

  // Created once, lazily, during the first render on the client. A ref assigned
  // during render would be a React rule violation; a state initialiser is the
  // supported way to say "make this once".
  const [ciphertextCache] = useState<CiphertextCache | null>(() =>
    typeof window === 'undefined' ? null : createDefaultCache(),
  );

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [vault, setVault] = useState<UnlockedVault | null>(null);
  const [reader, setReader] = useState<ArchiveReader | null>(null);
  const [messageCache, setMessageCache] = useState<MessageCache | null>(null);
  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [messagesByConversation, setMessages] = useState<Record<string, CanonicalMessage[]>>({});
  const [loadProgress, setLoadProgress] = useState<VaultContextValue['loadProgress']>(null);
  const [lastLoadSource, setLastLoadSource] = useState<'cache' | 'network' | null>(null);

  // A stable view of the loaded conversations, so `loadMessages` does not have
  // to change identity every time a conversation finishes loading.
  const messagesRef = useRef<Record<string, CanonicalMessage[]>>({});
  useEffect(() => {
    messagesRef.current = messagesByConversation;
  }, [messagesByConversation]);

  const refreshSession = useCallback(async () => {
    try {
      setSession(await api.session());
    } catch {
      setSession(null);
    } finally {
      setSessionLoaded(true);
    }
  }, [api]);

  /* Load the session once on mount. The work happens in an async function so
     no state is set synchronously during the effect, and the `active` flag stops
     a slow response from landing after the component has gone. */
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const current = await api.session();
        if (active) setSession(current);
      } catch {
        if (active) setSession(null);
      } finally {
        if (active) setSessionLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  const lock = useCallback(async () => {
    if (vault) lockVault(vault);
    setVault(null);
    setReader(null);
    setMessageCache(null);
    setConversations([]);
    setMessages({});
    setLastLoadSource(null);
    await ciphertextCache?.clear();
    await messageCache?.clear();
  }, [vault, ciphertextCache, messageCache]);

  /* Idle lock: an unattended tab should not stay readable. */
  useEffect(() => {
    if (!vault) return;
    let timer = window.setTimeout(() => void lock(), IDLE_LOCK_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void lock(), IDLE_LOCK_MS);
    };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'focus'];
    for (const event of events) window.addEventListener(event, reset, { passive: true });
    document.addEventListener('visibilitychange', reset, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [vault, lock]);

  const openReader = useCallback(
    async (unlocked: UnlockedVault) => {
      const created = await ArchiveReader.create({
        api,
        vault: unlocked,
        ...(ciphertextCache ? { cache: ciphertextCache } : {}),
      });
      const cache =
        typeof window === 'undefined'
          ? null
          : createMessageCache(await deriveSubkey(unlocked.key, 'index'));
      setVault(unlocked);
      setReader(created);
      setMessageCache(cache);
      return created;
    },
    [api, ciphertextCache],
  );

  const refreshConversationsWith = useCallback(async (activeReader: ArchiveReader | null) => {
    if (!activeReader) return;
    setConversationsLoading(true);
    try {
      setConversations(await activeReader.listConversations());
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  const refreshConversations = useCallback(
    () => refreshConversationsWith(reader),
    [reader, refreshConversationsWith],
  );

  const setupVault = useCallback(
    async (passphrase: string, timeZone: string) => {
      const created = await createVaultKeys(passphrase);
      await api.createVault(created.vault.bundle, timeZone);
      await refreshSession();
      const activeReader = await openReader(created.vault);
      await refreshConversationsWith(activeReader);
      return { recoveryKeyDisplay: created.recoveryKeyDisplay };
    },
    [api, openReader, refreshConversationsWith, refreshSession],
  );

  const unlock = useCallback(
    async (secret: string, kind: 'passphrase' | 'recovery') => {
      /* The wire shape and the crypto shape are checked against each other here
         rather than cast past each other: if they ever diverge, this stops
         compiling instead of failing at unlock time. */
      const bundle = session?.vault?.bundle;
      if (!bundle) throw new Error('This account has no archive key yet.');
      const unlocked =
        kind === 'passphrase'
          ? await unlockWithPassphrase(bundle, secret)
          : await unlockWithRecoveryKey(bundle, secret);
      const activeReader = await openReader(unlocked);
      await refreshConversationsWith(activeReader);
    },
    [openReader, refreshConversationsWith, session],
  );

  const changePassphrase = useCallback(
    async (next: string) => {
      if (!vault) throw new Error('Unlock the archive first.');
      const bundle = await rewrapWithPassphrase(vault, next);
      await api.updateVaultBundle(bundle, vault.keyId);
      await refreshSession();
    },
    [api, refreshSession, vault],
  );

  const newRecoveryKey = useCallback(async () => {
    if (!vault) throw new Error('Unlock the archive first.');
    const rotated = await rotateRecoveryKey(vault);
    await api.updateVaultBundle(rotated.bundle, vault.keyId);
    await refreshSession();
    return rotated.recoveryKeyDisplay;
  }, [api, refreshSession, vault]);

  /**
   * Load a conversation's messages.
   *
   * In order: already in memory, then the encrypted local cache, then the
   * archive itself — which is the only path that costs round trips, and the only
   * one that reports progress.
   */
  const loadMessages = useCallback(
    async (conversationId: string) => {
      const inMemory = messagesRef.current[conversationId];
      if (inMemory) return inMemory;

      const entry = conversations.find((candidate) => candidate.summary.id === conversationId);
      const manifest = entry?.manifest;
      if (!manifest || !reader) return [];

      const cached = await messageCache?.read(conversationId, manifest.manifestVersion);
      if (cached) {
        setMessages((previous) => ({ ...previous, [conversationId]: cached }));
        setLastLoadSource('cache');
        return cached;
      }

      setLoadProgress({ conversationId, done: 0, total: manifest.pages.length });
      try {
        const loaded = await reader.loadMessages(manifest, {
          onProgress: (done, total) => setLoadProgress({ conversationId, done, total }),
        });
        setMessages((previous) => ({ ...previous, [conversationId]: loaded }));
        setLastLoadSource('network');
        // Best effort: a cache that cannot be written is not a failed load.
        try {
          await messageCache?.write(conversationId, manifest.manifestVersion, loaded);
        } catch {
          /* ignore */
        }
        return loaded;
      } finally {
        setLoadProgress(null);
      }
    },
    [conversations, reader, messageCache],
  );

  const signOut = useCallback(async () => {
    await lock();
    try {
      await api.logout();
    } catch (error) {
      if (!(error instanceof ApiRequestError)) throw error;
    }
    setSession(null);
    window.location.href = '/';
  }, [api, lock]);

  const status: VaultStatus = !sessionLoaded
    ? 'loading'
    : !session
      ? 'signed-out'
      : !session.vault
        ? 'needs-setup'
        : vault
          ? 'unlocked'
          : 'locked';

  const value: VaultContextValue = {
    status,
    session,
    vault,
    reader,
    api,
    assumedTimeZone: session?.vault?.assumedTimeZone ?? 'UTC',
    conversations,
    conversationsLoading,
    messagesByConversation,
    loadProgress,
    lastLoadSource,
    refreshSession,
    refreshConversations,
    loadMessages,
    setupVault,
    unlock,
    changePassphrase,
    newRecoveryKey,
    lock,
    signOut,
  };

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}
