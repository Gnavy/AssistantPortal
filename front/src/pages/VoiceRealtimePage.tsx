/**
 * 实时语音全屏页（原球体可视化），由聊天页右上角电话进入。
 */
import { useEffect, useRef } from 'react';
import { PhoneOff, RefreshCw } from 'lucide-react';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import { useLiveAPI, type VoiceTurnCallback } from '../hooks/useLiveAPI';
import { clearPendingMicStream } from '../lib/pendingMic';
import avatarLottieSrc from '../avatar.lottie';

type Props = {
  onBack: () => void;
  conversationId: string;
  onVoiceAssistantReply?: VoiceTurnCallback;
};

export function VoiceRealtimePage({ onBack, conversationId, onVoiceAssistantReply }: Props) {
  const { connectionState, errorMessage, isConnected, connect, disconnect, transcript } = useLiveAPI(
    conversationId,
    onVoiceAssistantReply
  );
  const lottieCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lottieRef = useRef<DotLottie | null>(null);
  const lottieReadyRef = useRef(false);
  const completeListenerRef = useRef<(() => void) | null>(null);
  const isConnectedRef = useRef(isConnected);
  const prevConnectedRef = useRef(false);
  const isHangingUpRef = useRef(false);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const connectRef = useRef(connect);
  const disconnectRef = useRef(disconnect);
  connectRef.current = connect;
  disconnectRef.current = disconnect;
  const SEGMENT_INTRO: [number, number] = [1, 60];
  const SEGMENT_LOOP: [number, number] = [61, 230];
  const SEGMENT_HANGUP: [number, number] = [310, 360];
  const DEFAULT_FPS = 30;
  isConnectedRef.current = isConnected;

  /**
   * 仅挂载/卸载各一次。
   * - StrictMode 假卸载时 clearTimeout 会取消过早的建连；仅第二次挂载的定时器会执行。
   * - 若 delay=0，首帧与路由/动画切换重叠时，偶发首连失败而「点重试」因含 100ms 间隔可恢复；改为约 150ms 再连，与手动重试节奏一致。
   */
  const AUTO_CONNECT_DELAY_MS = 150;

  useEffect(() => {
    const id = window.setTimeout(() => {
      void connectRef.current();
    }, AUTO_CONNECT_DELAY_MS);
    return () => {
      window.clearTimeout(id);
      disconnectRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const playSegment = (segment: [number, number], loop: boolean) => {
    const player = lottieRef.current;
    if (!player) return;
    player.setLoop(loop);
    player.setSegment(segment[0], segment[1]);
    player.setFrame(segment[0]);
    player.play();
  };

  const clearCompleteListener = () => {
    const player = lottieRef.current;
    if (!player || !completeListenerRef.current) return;
    player.removeEventListener('complete', completeListenerRef.current);
    completeListenerRef.current = null;
  };

  const playSegmentOnce = (segment: [number, number], timeoutMs: number) =>
    new Promise<void>((resolve) => {
      const player = lottieRef.current;
      if (!player) {
        resolve();
        return;
      }
      clearCompleteListener();
      let settled = false;
      let frameRaf = 0;
      const done = () => {
        if (settled) return;
        settled = true;
        if (frameRaf) {
          window.cancelAnimationFrame(frameRaf);
          frameRaf = 0;
        }
        clearCompleteListener();
        resolve();
      };
      const onComplete = () => done();
      completeListenerRef.current = onComplete;
      player.addEventListener('complete', onComplete);
      playSegment(segment, false);
      const endFrame = segment[1];
      const watchFrame = () => {
        if (settled) return;
        if (player.currentFrame >= endFrame - 0.5) {
          done();
          return;
        }
        frameRaf = window.requestAnimationFrame(watchFrame);
      };
      frameRaf = window.requestAnimationFrame(watchFrame);
      window.setTimeout(done, timeoutMs);
    });

  const runIntroThenLoop = async () => {
    if (!lottieReadyRef.current || isHangingUpRef.current) return;
    await playSegmentOnce(SEGMENT_INTRO, 2500);
    if (!isHangingUpRef.current && isConnectedRef.current) {
      playSegment(SEGMENT_LOOP, true);
    }
  };

  const handleHangup = async () => {
    if (isHangingUpRef.current) return;
    isHangingUpRef.current = true;
    if (lottieRef.current && isConnected) {
      // 秒退场：触发挂断段后立刻返回，不等待播放完成。
      playSegment(SEGMENT_HANGUP, false);
    }
    clearPendingMicStream();
    disconnect();
    onBack();
  };

  const handleRetry = async () => {
    disconnect();
    // 小延迟让 cleanup 完成
    await new Promise((r) => setTimeout(r, 100));
    void connect();
  };

  const latestUserText = [...transcript].reverse().find((t) => t.role === 'user')?.text ?? '';
  const modelText = transcript
    .filter((t) => t.role === 'model')
    .slice(-8)
    .map((t) => t.text.trim())
    .filter(Boolean)
    .join('');
  const lastTranscript = transcript[transcript.length - 1];
  const isThinking = isConnected && connectionState !== 'error' && lastTranscript?.role === 'user' && !modelText;

  useEffect(() => {
    if (!transcriptContainerRef.current) return;
    transcriptContainerRef.current.scrollLeft = 0;
    transcriptContainerRef.current.scrollTo({
      left: 0,
      top: transcriptContainerRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [modelText, latestUserText]);

  useEffect(() => {
    const canvas = lottieCanvasRef.current;
    if (!canvas) return;
    const lottie = new DotLottie({
      canvas,
      src: avatarLottieSrc,
      autoplay: false,
      loop: false,
      useFrameInterpolation: true,
      renderConfig: {
        autoResize: true,
      },
    });
    lottieRef.current = lottie;
    const onReady = () => {
      lottieReadyRef.current = true;
      if (isConnectedRef.current && !isHangingUpRef.current) {
        void runIntroThenLoop();
      } else {
        lottie.setFrame(SEGMENT_INTRO[0]);
      }
    };
    lottie.addEventListener('ready', onReady);
    return () => {
      clearCompleteListener();
      lottie.removeEventListener('ready', onReady);
      lottieReadyRef.current = false;
      lottieRef.current = null;
      lottie.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isConnected && !prevConnectedRef.current) {
      void runIntroThenLoop();
    }
    if (!isConnected && prevConnectedRef.current && !isHangingUpRef.current) {
      clearCompleteListener();
      lottieRef.current?.stop();
      lottieRef.current?.setFrame(SEGMENT_INTRO[0]);
    }
    if (!isConnected) {
      isHangingUpRef.current = false;
    }
    prevConnectedRef.current = isConnected;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  /** 已连接：圆球与外围环用绿色；连接失败：红色；连接中/未连接：橙红 */
  const isError = connectionState === 'error';
  const statusText = isConnected
    ? '通话中 · 点击挂断'
    : connectionState === 'error'
      ? '连接失败'
      : connectionState === 'connecting'
        ? '连接豆包中…'
        : '已断开';

  const titleText = isConnected
    ? '聆听中'
    : connectionState === 'error'
      ? '连接失败'
      : connectionState === 'connecting'
        ? '请稍后'
        : '连接中';

  return (
    <div
      className="min-h-screen flex flex-col overflow-hidden relative bg-white text-[#1a1a1a]"
      style={{
        fontFamily:
          "'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans GB', 'Heiti SC', sans-serif",
      }}
    >
      <div
        className="absolute inset-0 pointer-events-none z-0"
        style={{
          background:
            'radial-gradient(circle at 50% 35%, rgba(0, 166, 192, 0.06) 0%, transparent 45%), radial-gradient(circle at 80% 90%, rgba(0, 0, 0, 0.02) 0%, transparent 40%)',
        }}
      />

      <main className="flex-1 flex flex-col items-center justify-center relative z-10 w-full px-4 pt-6">
        <div
          className="relative flex items-center justify-center will-change-transform"
          style={{
            width: '300px',
            height: '300px',
            transform: 'scale(1)',
            transition: 'none',
          }}
        >
          <canvas
            ref={lottieCanvasRef}
            style={{
              width: '260px',
              height: '260px',
              display: 'block',
            }}
          />
        </div>

        <div className="mt-8 text-center">
          <h1
            className={`mb-1.5 text-[#333] ${
              (isConnected || connectionState === 'connecting' || connectionState === 'disconnected')
                ? 'voice-listen-breathe text-sm font-medium tracking-[0.2em] uppercase'
                : 'text-2xl font-light tracking-widest uppercase'
            }`}
          >
            {titleText}
          </h1>
        </div>

        {/* 错误信息提示 */}
        {isError && errorMessage && (
          <div
            className="w-full max-w-[400px] mt-4 px-4 py-3 rounded-xl text-center bg-red-50 border border-red-200"
          >
            <p className="text-sm leading-relaxed text-red-700">
              {errorMessage}
            </p>
          </div>
        )}

        <div
          ref={transcriptContainerRef}
          className="w-full max-w-[680px] text-center mt-5 px-2"
          style={{
            height: '8.75em',
            overflowY: 'auto',
            overflowX: 'hidden',
            overscrollBehaviorX: 'none',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
          <div className="w-full pb-2">
            {latestUserText ? (
              <div
                style={{
                  fontSize: '12px',
                  color: 'rgba(0,0,0,0.45)',
                  marginBottom: '10px',
                  fontStyle: 'italic',
                }}
              >
                {latestUserText}
              </div>
            ) : null}
            {modelText ? (
              <div
                style={{
                  fontSize: '17px',
                  lineHeight: 1.75,
                  color: 'rgba(0,0,0,0.82)',
                  fontWeight: 300,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  overflowWrap: 'anywhere',
                }}
              >
                {modelText}
              </div>
            ) : isThinking ? (
              <div
                style={{
                  fontSize: '16px',
                  lineHeight: 1.75,
                  color: 'rgba(0,0,0,0.45)',
                  fontWeight: 400,
                }}
              >
                思考中...
              </div>
            ) : null}
          </div>
        </div>
      </main>

      <footer className="relative z-10 p-10 flex flex-col justify-center items-center gap-5">
        {isError ? (
          <button
            type="button"
            onClick={handleRetry}
            className="outline-none shadow-lg"
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '50%',
              border: '1px solid rgba(59, 130, 246, 0.5)',
              background: 'linear-gradient(145deg, #3b82f6 0%, #1d4ed8 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'transform 0.15s ease, box-shadow 0.15s ease',
              boxShadow: '0 8px 24px rgba(29, 78, 216, 0.45)',
            }}
            aria-label="重试连接"
          >
            <RefreshCw className="w-8 h-8 text-white" strokeWidth={2} />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleHangup}
            className="outline-none"
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '50%',
              border: '0px solid rgba(200, 95, 92, 0.45)',
              background: '#ef4444',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'transform 0.15s ease',
              boxShadow: 'none',
            }}
            aria-label="挂断"
          >
            <PhoneOff className="w-8 h-8 text-white" strokeWidth={2} />
          </button>
        )}
        <div className="text-[10px] tracking-[0.2em] uppercase text-[#888]">
          {isError ? '点击重试' : statusText}
        </div>
      </footer>
    </div>
  );
}
