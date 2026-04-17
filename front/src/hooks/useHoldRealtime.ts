import { useCallback, useRef, useState } from 'react';
import { PCMPlayer, AudioRecorder } from '../lib/audio';
import { releaseWebSocket } from '../lib/wsRelease';
import { resolveRealtimeWsUrl } from '../lib/apiBase';

function base64ToUint8Array(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 按住说话：建立 WebSocket + 麦克风，松开后结束会话。
 */
export function useHoldRealtime() {
  const [isHolding, setIsHolding] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<PCMPlayer | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const lastModelContentRef = useRef('');
  const modelStreamActiveRef = useRef(false);
  const lastModelContentAtRef = useRef(0);
  const lastInterruptAtRef = useRef(0);
  const onUpdateRef = useRef<(text: string) => void>(() => {});
  const abortHoldRef = useRef(false);

  const mergeContent = useCallback((raw: string) => {
    const normalized = raw;
    if (!normalized) return;

    const now = Date.now();
    const lastContent = lastModelContentRef.current;
    const isContinuousStream =
      modelStreamActiveRef.current && now - lastModelContentAtRef.current < 2500;
    const delta =
      isContinuousStream && lastContent && normalized.startsWith(lastContent)
        ? normalized.slice(lastContent.length)
        : normalized;

    if (!delta) return;
    modelStreamActiveRef.current = true;
    lastModelContentAtRef.current = now;
    lastModelContentRef.current = normalized;
    onUpdateRef.current(normalized);
  }, []);

  const cleanup = useCallback(() => {
    if (recorderRef.current) {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
    if (playerRef.current) {
      playerRef.current.close();
      playerRef.current = null;
    }
    if (wsRef.current) {
      const w = wsRef.current;
      wsRef.current = null;
      releaseWebSocket(w);
    }
    lastModelContentRef.current = '';
    modelStreamActiveRef.current = false;
    lastInterruptAtRef.current = 0;
  }, []);

  const stopHoldInner = useCallback(async () => {
    abortHoldRef.current = true;
    recorderRef.current?.stop();
    recorderRef.current = null;
    try {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'finish' }));
      }
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 200));
    cleanup();
    setIsHolding(false);
  }, [cleanup]);

  const startHold = useCallback(
    async (onAssistantUpdate: (text: string) => void) => {
      if (wsRef.current) return;

      abortHoldRef.current = false;
      onUpdateRef.current = onAssistantUpdate;
      lastModelContentRef.current = '';
      modelStreamActiveRef.current = false;

      playerRef.current = new PCMPlayer(() => {});
      recorderRef.current = new AudioRecorder(
        (base64Data) => {
          if (wsRef.current?.readyState !== WebSocket.OPEN) return;
          wsRef.current.send(base64ToUint8Array(base64Data));
        },
        () => {
          if (wsRef.current?.readyState !== WebSocket.OPEN) return;
          if (!playerRef.current?.isPlaying()) return;
          const now = Date.now();
          if (now - lastInterruptAtRef.current < 500) return;
          lastInterruptAtRef.current = now;
          playerRef.current.stop();
          wsRef.current.send(JSON.stringify({ type: 'interrupt' }));
        }
      );

      const ws = new WebSocket(resolveRealtimeWsUrl());
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      const onStreamMessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          const base64Audio = btoa(String.fromCharCode(...bytes));
          playerRef.current?.play(base64Audio);
          return;
        }
        if (typeof event.data === 'string') {
          try {
            const payload = JSON.parse(event.data) as {
              type?: string;
              event?: number;
              content?: string;
            };
            if (payload.type === 'bridge_ready' || payload.type === 'bridge_error') {
              return;
            }
            if (payload.content !== undefined) {
              mergeContent(String(payload.content));
            }
            if (payload.event && [152, 153, 359, 559].includes(payload.event)) {
              modelStreamActiveRef.current = false;
            }
          } catch {
            // ignore
          }
        }
      };

      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const done = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
          };
          const t = window.setTimeout(
            () => done(() => reject(new Error('与豆包上游握手超时'))),
            25000
          );
          ws.onopen = () => {};
          ws.onerror = () => {
            window.clearTimeout(t);
            done(() => reject(new Error('WebSocket 连接失败')));
          };
          ws.onclose = () => {
            window.clearTimeout(t);
            done(() => reject(new Error('连接在握手完成前被关闭')));
          };
          const onHandshake = (event: MessageEvent) => {
            if (typeof event.data !== 'string') return;
            try {
              const p = JSON.parse(event.data) as { type?: string; message?: string };
              if (p.type === 'bridge_ready') {
                window.clearTimeout(t);
                ws.removeEventListener('message', onHandshake);
                done(() => resolve());
              }
              if (p.type === 'bridge_error') {
                window.clearTimeout(t);
                ws.removeEventListener('message', onHandshake);
                done(() => reject(new Error(p.message || '上游连接失败')));
              }
            } catch {
              // ignore non-JSON
            }
          };
          ws.addEventListener('message', onHandshake);
        });
      } catch (e) {
        cleanup();
        setIsHolding(false);
        throw e instanceof Error ? e : new Error('WebSocket 连接失败');
      }

      ws.onmessage = onStreamMessage;

      if (abortHoldRef.current) {
        cleanup();
        setIsHolding(false);
        return;
      }

      setIsHolding(true);
      try {
        await recorderRef.current?.start();
      } catch (e) {
        cleanup();
        setIsHolding(false);
        throw e;
      }
      if (abortHoldRef.current) {
        await stopHoldInner();
      }
    },
    [cleanup, mergeContent, stopHoldInner]
  );

  const stopHold = useCallback(async () => {
    await stopHoldInner();
  }, [stopHoldInner]);

  return { isHolding, startHold, stopHold };
}
