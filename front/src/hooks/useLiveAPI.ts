import { useState, useRef, useCallback } from 'react';
import { PCMPlayer, AudioRecorder } from '../lib/audio';
import { clearPendingMicStream, takePendingMicStream } from '../lib/pendingMic';
import { releaseWebSocket } from '../lib/wsRelease';
import { resolveRealtimeWsUrl } from '../lib/apiBase';
import { pickAudioContextForUi, playConnectChime, playHangupChime } from '../lib/uiSounds';

type TranscriptItem = { role: 'user' | 'model', text: string };

/** 实时语音回合结束：助手最终回复 + 本轮用户 ASR 定稿（若有） */
export type VoiceTurnCallback = (assistantText: string, userTranscript?: string) => void;

function base64ToUint8Array(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export function useLiveAPI(conversationId: string, onVoiceAssistantReply?: VoiceTurnCallback) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<PCMPlayer | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const lastModelContentRef = useRef('');
  const modelStreamActiveRef = useRef(false);
  const lastModelContentAtRef = useRef(0);
  const pendingModelTextRef = useRef('');
  const revealBudgetRef = useRef(0);
  const audioTimeBudgetRef = useRef(0);
  const revealTimerRef = useRef<number | null>(null);
  const lastInterruptAtRef = useRef(0);
  /** assistant_final_done 去重：避免同一 turn_id 的事件重复触发回调导致“回答重复” */
  const lastAssistantFinalDoneTurnIdRef = useRef<string | null>(null);
  /** 兜底去重：短窗内同 user+assistant 的回调只提交一次 */
  const lastCommittedVoiceReplyRef = useRef<{ user: string; assistant: string; ts: number } | null>(null);
  /** 防回声：助手音频播放/刚结束时，短暂静音麦克风上行给 ASR */
  const assistantMicSquelchUntilRef = useRef<number>(0);
  const lastPlayerPlayingRef = useRef<boolean>(false);
  const connectTimeoutRef = useRef<number | null>(null);
  /** 浏览器 WS 已 open，但后端与豆包上游尚未就绪；超时未收到 bridge_ready 则报错 */
  const bridgeReadyTimeoutRef = useRef<number | null>(null);
  const bridgeReadyHandledRef = useRef(false);
  /** 收到 bridge_ready 前连接就断开时，自动再连一次（对齐手动「重试」间隔，避免首进页偶发失败） */
  const prematureBridgeCloseCountRef = useRef(0);
  const autoRetryTimerRef = useRef<number | null>(null);
  const keepAliveTimerRef = useRef<number | null>(null);
  /** 每次新 connect 递增；防止旧 WS 晚到的 onmessage/onclose 与新会话并发导致双重播放或误 cleanup */
  const liveSessionRef = useRef(0);
  const connectRef = useRef<(opts?: { fromAutoRetry?: boolean }) => void>(() => {});
  const currentTurnModelTextRef = useRef('');
  const activeTurnIdRef = useRef('');
  const activeTurnSourceRef = useRef<'text' | 'voice' | ''>('');
  const activeAssistantPhaseRef = useRef<'comfort' | 'final'>('final');
  const activeTurnUserTextRef = useRef('');
  /** 451 非流式定稿的用户识别文本，用于写入聊天历史 */
  const lastFinalUserAsrRef = useRef('');
  /** 麦克风已成功启动、通话有效；用于挂断提示音（不依赖 stateRef 与 React 批处理时序） */
  const callActiveRef = useRef(false);
  // 用 ref 跟踪连接状态，避免 onclose 闭包中读到陈旧 state
  const stateRef = useRef<ConnectionState>('disconnected');

  const OUTPUT_SAMPLE_RATE = 24000;
  const BYTES_PER_SAMPLE = 2;
  const DISPLAY_CHARS_PER_SECOND = 5.5;
  const MAX_REVEAL_CHARS_PER_TICK = 3;
  const CONNECTION_TIMEOUT_MS = 8000;
  const BRIDGE_READY_TIMEOUT_MS = 25000;

  const setState = useCallback((s: ConnectionState) => {
    stateRef.current = s;
    setConnectionState(s);
  }, []);

  const appendModelVisibleDelta = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setTranscript((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role !== 'model') return [...prev, { role: 'model', text: t }];

      const lastText = last.text;
      if (lastText === t) return prev;

      // 后片包含前片前缀：直接用后片替换最后一段，避免 “xxx + xxx(含前缀)” 的重叠重复
      if (t.startsWith(lastText)) {
        return [...prev.slice(0, -1), { role: 'model', text: t }];
      }
      // 前片包含后片前缀：说明后片更短（或重复内容），保留更长的 last
      if (lastText.startsWith(t)) {
        return prev;
      }

      // suffix-prefix overlap：避免 “xxx(结尾重合) + (后片重含xxx结尾)” 的重复
      const maxOverlap = Math.min(lastText.length, t.length);
      let overlap = 0;
      for (let k = maxOverlap; k >= 1; k--) {
        if (lastText.endsWith(t.slice(0, k))) {
          overlap = k;
          break;
        }
      }
      const merged = lastText + t.slice(overlap);
      if (merged === lastText) return prev;
      return [...prev.slice(0, -1), { role: 'model', text: merged }];
    });
  }, []);

  /** 实时字幕：更新本轮用户识别（451 流式/定稿均刷新展示） */
  const mergeUserAsrDisplay = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setTranscript((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'user') {
        return [...prev.slice(0, -1), { role: 'user', text: t }];
      }
      return [...prev, { role: 'user', text: t }];
    });
  }, []);

  const flushReveal = useCallback((forceAll = false, maxChars = Number.POSITIVE_INFINITY) => {
    const pending = pendingModelTextRef.current;
    if (!pending) return;

    if (forceAll) {
      appendModelVisibleDelta(pending);
      pendingModelTextRef.current = '';
      revealBudgetRef.current = 0;
      return;
    }

    const revealChars = Math.min(Math.floor(revealBudgetRef.current), maxChars);
    if (revealChars <= 0) return;

    const chunk = pending.slice(0, revealChars);
    if (!chunk) return;

    appendModelVisibleDelta(chunk);
    pendingModelTextRef.current = pending.slice(chunk.length);
    revealBudgetRef.current = Math.max(0, revealBudgetRef.current - chunk.length);
  }, [appendModelVisibleDelta]);

  const tickReveal = useCallback(() => {
    if (audioTimeBudgetRef.current <= 0) return;
    const tickSeconds = Math.min(audioTimeBudgetRef.current, 0.1);
    audioTimeBudgetRef.current -= tickSeconds;
    revealBudgetRef.current += tickSeconds * DISPLAY_CHARS_PER_SECOND;
    flushReveal(false, MAX_REVEAL_CHARS_PER_TICK);
  }, [flushReveal]);

  const appendModelDelta = useCallback((content: string) => {
    const normalized = content;
    if (!normalized) return;

    const now = Date.now();
    const lastContent = lastModelContentRef.current;
    const isContinuousStream =
      modelStreamActiveRef.current && (now - lastModelContentAtRef.current) < 2500;
    const delta = (isContinuousStream && lastContent && normalized.startsWith(lastContent))
      ? normalized.slice(lastContent.length)
      : normalized;

    if (!delta) return;
    modelStreamActiveRef.current = true;
    lastModelContentAtRef.current = now;
    lastModelContentRef.current = normalized;
    pendingModelTextRef.current += delta;
    currentTurnModelTextRef.current += delta;
  }, []);

  const resetTurnBuffers = useCallback(() => {
    pendingModelTextRef.current = '';
    revealBudgetRef.current = 0;
    currentTurnModelTextRef.current = '';
    modelStreamActiveRef.current = false;
    lastModelContentRef.current = '';
    lastModelContentAtRef.current = 0;
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
    const w = wsRef.current;
    wsRef.current = null;
    releaseWebSocket(w);
    if (revealTimerRef.current) {
      window.clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    if (connectTimeoutRef.current) {
      window.clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    if (bridgeReadyTimeoutRef.current) {
      window.clearTimeout(bridgeReadyTimeoutRef.current);
      bridgeReadyTimeoutRef.current = null;
    }
    if (autoRetryTimerRef.current) {
      window.clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }
    if (keepAliveTimerRef.current) {
      window.clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = null;
    }
    bridgeReadyHandledRef.current = false;
    callActiveRef.current = false;
    pendingModelTextRef.current = '';
    revealBudgetRef.current = 0;
    audioTimeBudgetRef.current = 0;
    modelStreamActiveRef.current = false;
    lastModelContentAtRef.current = 0;
    lastInterruptAtRef.current = 0;
    currentTurnModelTextRef.current = '';
    activeTurnIdRef.current = '';
    activeTurnSourceRef.current = '';
    activeAssistantPhaseRef.current = 'final';
    activeTurnUserTextRef.current = '';
    lastFinalUserAsrRef.current = '';
    assistantMicSquelchUntilRef.current = 0;
    lastPlayerPlayingRef.current = false;
    lastCommittedVoiceReplyRef.current = null;
    setVolume(0);
  }, []);

  const connect = useCallback(async (opts?: { fromAutoRetry?: boolean }) => {
    if (wsRef.current) {
      return;
    }

    if (!opts?.fromAutoRetry) {
      prematureBridgeCloseCountRef.current = 0;
    }

    // 清掉上一任可能残留的播放器/录音机（避免双 PCM / 双路音频）
    cleanup();

    const session = ++liveSessionRef.current;

    setState('connecting');
    setErrorMessage(null);
    bridgeReadyHandledRef.current = false;

    try {
      playerRef.current = new PCMPlayer((v) => setVolume(v));
      recorderRef.current = new AudioRecorder(
        (base64Data) => {
          if (wsRef.current?.readyState !== WebSocket.OPEN) return;

          // 在助手播音期间（或刚结束后短窗），不要把麦克风音频送给 ASR
          // 否则会把“助手语音内容”识别成新的用户输入，从而触发重复回答。
          const player = playerRef.current;
          const now = Date.now();
          const playing = !!player?.isPlaying();
          if (lastPlayerPlayingRef.current && !playing) {
            assistantMicSquelchUntilRef.current = now + 600;
          }
          lastPlayerPlayingRef.current = playing;
          if (playing || now < assistantMicSquelchUntilRef.current) return;

          const bytes = base64ToUint8Array(base64Data);
          wsRef.current.send(bytes);
        },
        () => {
          // 用户一发声就立即解除静音，恢复快速打断/连续对话能力。
          assistantMicSquelchUntilRef.current = 0;
          lastPlayerPlayingRef.current = false;
          if (wsRef.current?.readyState !== WebSocket.OPEN) return;
          if (!playerRef.current?.isPlaying()) return;
          const now = Date.now();
          if (now - lastInterruptAtRef.current < 500) return;
          lastInterruptAtRef.current = now;
          playerRef.current.stop();
          audioTimeBudgetRef.current = 0;
          wsRef.current.send(JSON.stringify({ type: 'interrupt' }));
        }
      );

      const ws = new WebSocket(resolveRealtimeWsUrl(conversationId));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      // 连接超时：如果 WS 在 N 秒内未打开，视为失败
      connectTimeoutRef.current = window.setTimeout(() => {
        if (session !== liveSessionRef.current) return;
        if (ws.readyState !== WebSocket.OPEN) {
          setErrorMessage('连接超时，请检查后端服务是否正常运行');
          setState('error');
          releaseWebSocket(ws);
          wsRef.current = null;
          cleanup();
        }
      }, CONNECTION_TIMEOUT_MS);

      const startMicAfterBridge = async () => {
        if (session !== liveSessionRef.current) return;
        setState('connected');
        if (keepAliveTimerRef.current) {
          window.clearInterval(keepAliveTimerRef.current);
          keepAliveTimerRef.current = null;
        }
        keepAliveTimerRef.current = window.setInterval(() => {
          if (session !== liveSessionRef.current) return;
          if (wsRef.current?.readyState !== WebSocket.OPEN) return;
          wsRef.current.send(JSON.stringify({ type: 'keep_alive' }));
        }, 8000);
        try {
          const pre = takePendingMicStream();
          await recorderRef.current?.start(pre ?? undefined);
          if (session === liveSessionRef.current) {
            callActiveRef.current = true;
            const uiCtx = pickAudioContextForUi(playerRef.current, recorderRef.current);
            if (uiCtx) {
              playConnectChime(uiCtx);
            }
          }
          if (revealTimerRef.current) {
            window.clearInterval(revealTimerRef.current);
          }
          revealTimerRef.current = window.setInterval(() => tickReveal(), 100);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setErrorMessage('麦克风启动失败: ' + msg);
          setState('error');
          clearPendingMicStream();
          releaseWebSocket(ws);
          wsRef.current = null;
        }
      };

      ws.onopen = () => {
        if (session !== liveSessionRef.current) return;
        if (connectTimeoutRef.current) {
          window.clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        ws.send(JSON.stringify({ type: 'set_conversation_id', conversation_id: conversationId }));
        // TCP 握手完成 ≠ 豆包上游就绪；等 bridge_ready 再开麦并显示「通话中」
        bridgeReadyTimeoutRef.current = window.setTimeout(() => {
          if (session !== liveSessionRef.current) return;
          if (stateRef.current === 'connecting') {
            setErrorMessage('与豆包上游握手超时，请检查服务端网络、config 与鉴权（见后端日志）');
            setState('error');
            releaseWebSocket(ws);
            wsRef.current = null;
            cleanup();
          }
        }, BRIDGE_READY_TIMEOUT_MS);
      };

      ws.onmessage = (event) => {
        if (session !== liveSessionRef.current) return;
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          const base64Audio = btoa(String.fromCharCode(...bytes));
          playerRef.current?.play(base64Audio);
          const seconds = bytes.byteLength / (OUTPUT_SAMPLE_RATE * BYTES_PER_SAMPLE);
          // 防回声：收到后端播音音频时，给麦克风上行一个“直到播放结束”的静音窗口。
          // 否则可能把助手语音识别成新的用户输入，导致双回合不同回答。
          const now = Date.now();
          assistantMicSquelchUntilRef.current = Math.max(
            assistantMicSquelchUntilRef.current,
            now + seconds * 1000 + 2500
          );
          audioTimeBudgetRef.current += seconds;
          return;
        }

        if (typeof event.data === 'string') {
          try {
            const payload = JSON.parse(event.data) as {
              type?: string;
              message?: string;
              turn_id?: string;
              source?: 'text' | 'voice';
              phase?: 'comfort' | 'final';
              user_text?: string;
              event?: number;
              content?: string;
              results?: Array<{ text?: string; is_interim?: boolean }>;
            };

            if (payload.type === 'bridge_ready') {
              if (bridgeReadyHandledRef.current) return;
              bridgeReadyHandledRef.current = true;
              prematureBridgeCloseCountRef.current = 0;
              if (bridgeReadyTimeoutRef.current) {
                window.clearTimeout(bridgeReadyTimeoutRef.current);
                bridgeReadyTimeoutRef.current = null;
              }
              void startMicAfterBridge();
              return;
            }
            if (payload.type === 'bridge_error') {
              if (bridgeReadyTimeoutRef.current) {
                window.clearTimeout(bridgeReadyTimeoutRef.current);
                bridgeReadyTimeoutRef.current = null;
              }
              setErrorMessage(payload.message || '上游连接失败');
              setState('error');
              releaseWebSocket(ws);
              wsRef.current = null;
              cleanup();
              return;
            }
            if (payload.type === 'upstream_error') {
              if (bridgeReadyTimeoutRef.current) {
                window.clearTimeout(bridgeReadyTimeoutRef.current);
                bridgeReadyTimeoutRef.current = null;
              }
              setErrorMessage(payload.message || '上游服务返回错误');
              setState('error');
              releaseWebSocket(ws);
              wsRef.current = null;
              cleanup();
              return;
            }
            if (payload.type === 'upstream_closed') {
              if (bridgeReadyTimeoutRef.current) {
                window.clearTimeout(bridgeReadyTimeoutRef.current);
                bridgeReadyTimeoutRef.current = null;
              }
              setErrorMessage(payload.message || '上游连接已关闭');
              setState('error');
              releaseWebSocket(ws);
              wsRef.current = null;
              cleanup();
              return;
            }
            if (payload.type === 'turn_start') {
              activeTurnIdRef.current = payload.turn_id || '';
              activeTurnSourceRef.current = payload.source || '';
              activeTurnUserTextRef.current = payload.user_text || '';
              activeAssistantPhaseRef.current = 'final';
              lastFinalUserAsrRef.current = payload.source === 'voice' ? '' : lastFinalUserAsrRef.current;
              resetTurnBuffers();
              return;
            }
            if (payload.type === 'assistant_phase') {
              activeAssistantPhaseRef.current = payload.phase || 'final';
              if (payload.phase === 'comfort') {
                // Comfort 只是占位/安抚音频，不应进入字幕/最终文案缓冲。
                // 同步字幕节奏：清空音频预算，避免 comfort 音频时间把后续字幕节奏提前。
                audioTimeBudgetRef.current = 0;
                resetTurnBuffers();
              } else if (payload.phase === 'final') {
                resetTurnBuffers();
              }
              return;
            }
            if (payload.type === 'assistant_text') {
              if (payload.phase !== 'final') {
                return;
              }
              if (typeof payload.content === 'string' && payload.content) {
                appendModelDelta(payload.content);
              }
              return;
            }
            if (payload.type === 'assistant_final_done') {
              // final_done 之后仍可能有少量回声尾音/调度延迟，额外再静音一小段时间
              assistantMicSquelchUntilRef.current = Math.max(
                assistantMicSquelchUntilRef.current,
                Date.now() + 2500
              );
              audioTimeBudgetRef.current += pendingModelTextRef.current.length / DISPLAY_CHARS_PER_SECOND;
              flushReveal(true);
              const finalReply = currentTurnModelTextRef.current.trim();
              const doneTurnId = typeof payload.turn_id === 'string' ? payload.turn_id : '';
              const shouldSkipCallback = !!doneTurnId && lastAssistantFinalDoneTurnIdRef.current === doneTurnId;
              if (doneTurnId && !shouldSkipCallback) {
                lastAssistantFinalDoneTurnIdRef.current = doneTurnId;
              }
              const userLine =
                (typeof payload.user_text === 'string' ? payload.user_text.trim() : '')
                || (activeTurnSourceRef.current === 'voice' ? lastFinalUserAsrRef.current.trim() : activeTurnUserTextRef.current.trim())
                || undefined;
              if (!shouldSkipCallback && finalReply && onVoiceAssistantReply) {
                const now = Date.now();
                const userKey = (userLine || '').trim();
                const assistantKey = finalReply.trim();
                const lastCommitted = lastCommittedVoiceReplyRef.current;
                const isDuplicateCommit = !!lastCommitted
                  && lastCommitted.user === userKey
                  && lastCommitted.assistant === assistantKey
                  && (now - lastCommitted.ts) < 8000;
                if (!isDuplicateCommit) {
                  onVoiceAssistantReply(finalReply, userLine);
                  lastCommittedVoiceReplyRef.current = { user: userKey, assistant: assistantKey, ts: now };
                }
              }
              resetTurnBuffers();
              activeAssistantPhaseRef.current = 'final';
              activeTurnIdRef.current = '';
              activeTurnSourceRef.current = '';
              activeTurnUserTextRef.current = '';
              lastFinalUserAsrRef.current = '';
              return;
            }

            const ev = payload.event;

            // 450 ASR 开始 / 451 ASR 结果（豆包实时对话协议）
            if (ev === 450) {
              resetTurnBuffers();
              lastFinalUserAsrRef.current = '';
            } else if (ev === 451) {
              const r0 = payload.results?.[0];
              if (r0?.text) {
                mergeUserAsrDisplay(String(r0.text));
                if (!r0.is_interim) {
                  lastFinalUserAsrRef.current = String(r0.text).trim();
                }
              }
            } else if (
              activeAssistantPhaseRef.current === 'final' &&
              typeof payload.content === 'string' &&
              payload.content &&
              (ev === undefined || ev === null || ev === 550)
            ) {
              appendModelDelta(payload.content);
            }

            if (payload.event && [152, 153, 359, 559].includes(payload.event)) {
              // 新协议下由 assistant_final_done 收口；这里保留兼容旧事件，不再重复提交回调。
            } else if (payload.message) {
              console.warn('后端事件消息:', payload.message);
            }
          } catch {
            // 忽略非 JSON 文本消息
          }
        }
      };

      ws.onerror = () => {
        if (session !== liveSessionRef.current) return;
        setErrorMessage('WebSocket 连接失败，请检查后端服务是否运行在 ' + resolveRealtimeWsUrl());
        setState('error');
      };

      ws.onclose = (event) => {
        if (session !== liveSessionRef.current) return;
        if (bridgeReadyTimeoutRef.current) {
          window.clearTimeout(bridgeReadyTimeoutRef.current);
          bridgeReadyTimeoutRef.current = null;
        }

        const connectingNoBridge =
          stateRef.current === 'connecting' && !bridgeReadyHandledRef.current;

        flushReveal(true);
        modelStreamActiveRef.current = false;
        lastModelContentRef.current = '';
        lastInterruptAtRef.current = 0;
        cleanup();

        if (connectingNoBridge) {
          prematureBridgeCloseCountRef.current += 1;
          if (prematureBridgeCloseCountRef.current <= 1) {
            setState('connecting');
            setErrorMessage(null);
            if (autoRetryTimerRef.current) {
              window.clearTimeout(autoRetryTimerRef.current);
            }
            autoRetryTimerRef.current = window.setTimeout(() => {
              autoRetryTimerRef.current = null;
              void connectRef.current({ fromAutoRetry: true });
            }, 200);
            return;
          }
        }

        if (stateRef.current === 'connecting') {
          const reason = event.reason || '未知原因';
          setErrorMessage('连接被关闭: ' + reason + ' (code: ' + event.code + ')');
          setState('error');
        } else if (stateRef.current !== 'error') {
          setState('disconnected');
        }
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage('连接失败: ' + msg);
      setState('error');
      cleanup();
    }
  }, [appendModelDelta, cleanup, conversationId, flushReveal, mergeUserAsrDisplay, onVoiceAssistantReply, resetTurnBuffers, setState, tickReveal]);

  connectRef.current = connect;

  const disconnect = useCallback(() => {
    if (callActiveRef.current) {
      const uiCtx = pickAudioContextForUi(playerRef.current, recorderRef.current);
      if (uiCtx) {
        playHangupChime(uiCtx);
      } else {
        try {
          const c = new AudioContext();
          void c.resume().then(() => {
            playHangupChime(c);
            window.setTimeout(() => void c.close(), 500);
          });
        } catch {
          // ignore
        }
      }
    }
    callActiveRef.current = false;
    liveSessionRef.current += 1;
    if (autoRetryTimerRef.current) {
      window.clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }
    if (keepAliveTimerRef.current) {
      window.clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = null;
    }
    const w = wsRef.current;
    wsRef.current = null;
    releaseWebSocket(w);
    cleanup();
    setConnectionState('disconnected');
    stateRef.current = 'disconnected';
    prematureBridgeCloseCountRef.current = 0;
    setErrorMessage(null);
    flushReveal(true);
    modelStreamActiveRef.current = false;
    lastModelContentRef.current = '';
    lastInterruptAtRef.current = 0;
  }, [cleanup, flushReveal]);

  return {
    connectionState,
    errorMessage,
    isConnected: connectionState === 'connected',
    connect,
    disconnect,
    volume,
    transcript
  };
}
