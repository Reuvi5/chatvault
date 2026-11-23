'use client';

/**
 * Client-side vault state.
 *
 * The master key lives here, in memory, for as long as the tab is open and
 * active. It is never written to storage, never sent anywhere, and is zeroed
 * when the vault is locked — by the person, by the idle timer, or by closing the
 * tab. Reloading the page therefore means unlocking again, which is the correct
 * behaviour for an archive whose keys the server cannot hold.
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
  type CiphertextCache,
  type ConversationEntry,
  type SessionInfo,
} from '@chatvault/client';
import {
  createVault as createVaultKeys,
  lockVault,
  rewrapWithPassphrase,
  rotateRecoveryKey,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  type UnlockedVault,
  type VaultBundle,
} from '@chatvault/crypto';
import type { VaultBundleWire } from '@chatvault/protocol';
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
  const cacheRef = useRef<CiphertextCache | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [vault, setVault] = useState<UnlockedVault | null>(null);
  const [reader, setReader] = useState<ArchiveReader | null>(null);
  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [messagesByConversation, setMessages] = useState<Record<string, CanonicalMessage[]>>({});
  const [loadProgress, setLoadProgress] = useState<VaultContextValue['loadProgress']>(null);

  if (!cacheRef.current && typeof window !== 'undefined') {
    cacheRef.current = createDefaultCache();
  }

  const refreshSession = useCallback(async () => {
    try {
      setSession(await api.session());
    } catch {
      setSession(null);
    } finally {
      setSessionLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const lock = useCallback(async () => {
    if (vault) lockVault(vault);
    setVault(null);
    setReader(null);
    setConversations([]);
    setMessages({});
    await cacheRef.current?.clear();
  }, [vault]);

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
        ...(cacheRef.current ? { cache: cacheRef.current } : {}),
      });
      setVault(unlocked);
      setReader(created);
      return created;
    },
    [api],
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
      await api.createVault(created.vault.bundle as unknown as VaultBundleWire, timeZone);
      await refreshSession();
      const activeReader = await openReader(created.vault);
      await refreshConversationsWith(activeReader);
      return { recoveryKeyDisplay: created.recoveryKeyDisplay };
    },
    [api, openReader, refreshConversationsWith, refreshSession],
  );

  const unlock = useCallback(
    async (secret: string, kind: 'passphrase' | 'recovery') => {
      const bundle = session?.vault?.bundle as unknown as VaultBundle | undefined;
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
      await api.updateVaultBundle(bundle as unknown as VaultBundleWire, vault.keyId);
      await refreshSession();
    },
    [api, refreshSession, vault],
  );

  const newRecoveryKey = useCallback(async () => {
    if (!vault) throw new Error('Unlock the archive first.');
    const rotated = await rotateRecoveryKey(vault);
    await api.updateVaultBundle(rotated.bundle as unknown as VaultBundleWire, vault.keyId);
    await refreshSession();
    return rotated.recoveryKeyDisplay;
  }, [api, refreshSession, vault]);

  const loadMessages = useCallback(
    async (conversationId: string) => {
      const cached = messagesByConversation[conversationId];
      if (cached) return cached;
      const entry = conversations.find((candidate) => candidate.summary.id === conversationId);
      if (!entry?.manifest || !reader) return [];
      setLoadProgress({ conversationId, done: 0, total: entry.manifest.pages.length });
      try {
        const loaded = await reader.loadMessages(entry.manifest, {
          onProgress: (done, total) => setLoadProgress({ conversationId, done, total }),
        });
        setMessages((previous) => ({ ...previous, [conversationId]: loaded }));
        return loaded;
      } finally {
        setLoadProgress(null);
      }
    },
    [conversations, messagesByConversation, reader],
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
