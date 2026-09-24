'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameId } from '@human-bingo/domain';
import { RealtimeGameSocket } from '@human-bingo/browser-client/realtime-client';
import type { RealtimeSocketStatus } from '@human-bingo/browser-client/realtime-client';
import { GameSyncController, HttpGameTransport } from '@human-bingo/browser-client/transport';
import type { NormalizedGameView } from '@human-bingo/browser-client/state';
import { realtimeBaseUrl } from './api';

export type GameConnectionStatus = 'loading' | 'connected' | 'reconnecting' | 'error';

export interface GameSession {
  readonly view: NormalizedGameView | null;
  readonly status: GameConnectionStatus;
  readonly error: string | null;
  readonly refresh: () => Promise<boolean>;
}

export function useGameSession(gameId: string): GameSession {
  const [view, setView] = useState<NormalizedGameView | null>(null);
  const [status, setStatus] = useState<GameConnectionStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<GameSyncController | null>(null);
  const socketRef = useRef<RealtimeGameSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let socket: RealtimeGameSocket | null = null;
    const id = gameId as GameId;
    const controller = new GameSyncController({
      gameId: id,
      loader: new HttpGameTransport(async (input, init) => {
        const response = await fetch(input, init);
        return response;
      }),
      pollIntervalMs: 10_000,
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe((nextView) => {
      if (!disposed) setView(nextView);
    });

    void controller.loadInitialSnapshot().then((loaded) => {
      if (disposed) return;
      if (!loaded || controller.cache.current === null) {
        setStatus('error');
        setError('This card could not be loaded. Reopen your invitation and try again.');
        return;
      }

      setError(null);
      const onEvent = (event: Parameters<GameSyncController['handleRealtimeEvent']>[0]): void => {
        const needsSnapshot = event.type === 'snapshot_required';
        void controller.handleRealtimeEvent(event).then(() => {
          const currentVersion = controller.cache.currentVersion;
          if (needsSnapshot && currentVersion !== undefined) {
            socket?.acknowledgeStateVersion(currentVersion);
          }
        });
      };

      socket = new RealtimeGameSocket({
        wsUrl: realtimeBaseUrl(),
        gameId: id,
        initialStateVersion: controller.cache.currentVersion,
        onEvent,
        onStatusChange: (connection: RealtimeSocketStatus) => {
          if (disposed) return;
          if (connection === 'connected') {
            controller.stopPolling();
            setStatus('connected');
          } else if (connection === 'reconnecting') {
            controller.startPolling();
            setStatus('reconnecting');
          }
        },
      });
      socketRef.current = socket;
      socket.connect();
    });

    return () => {
      disposed = true;
      unsubscribe();
      socket?.close();
      socketRef.current = null;
      controller.stopPolling();
      controllerRef.current = null;
    };
  }, [gameId]);

  const refresh = useCallback(async () => {
    const controller = controllerRef.current;
    if (controller === null) return false;
    const loaded = await controller.loadInitialSnapshot();
    if (!loaded) {
      setError('The game could not be refreshed. Check your connection and retry.');
    } else {
      setError(null);
      const currentVersion = controller.cache.currentVersion;
      if (currentVersion !== undefined) {
        socketRef.current?.acknowledgeStateVersion(currentVersion);
      }
    }
    return loaded;
  }, []);

  return { view, status, error, refresh };
}
