import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import {
  AudioLines,
  Camera,
  ChevronDown,
  Copy,
  FileText,
  Keyboard,
  Mic,
  Plus,
  Search,
  Sparkles,
  Zap,
  Phone,
} from 'lucide-react';
import { streamTextQuery } from '../lib/textSse';
import { setPendingMicStream } from '../lib/pendingMic';
import hiLottie from '../hi.lottie';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  voice?: boolean;
};

type Props = {
  onOpenVoice: () => void;
  messages?: ChatMessage[];
  setMessages?: Dispatch<SetStateAction<ChatMessage[]>>;
  conversationId?: string;
};

const QUICK_ACTIONS = [
  { label: '快速', icon: Zap },
  { label: 'AI 创作', icon: Sparkles },
  { label: '拍题答疑', icon: Search },
  { label: 'PPT 生成', icon: FileText },
];

export function ChatPage({
  onOpenVoice,
  messages = [],
  setMessages = () => {},
  conversationId = 'default',
}: Props) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<any>(null);
  const speechFinalRef = useRef('');
  const speechInterimRef = useRef('');
  const speechReleasedRef = useRef(false);
  const lottieCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lottieRef = useRef<DotLottie | null>(null);
  const [showWelcomeAnimation, setShowWelcomeAnimation] = useState(() => messages.length === 0);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (recognitionRef.current) {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = listRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    });
    return () => cancelAnimationFrame(id);
  }, [messages]);

  useEffect(() => {
    if (messages.length > 0) {
      setShowWelcomeAnimation(false);
    }
  }, [messages.length]);

  useEffect(() => {
    if (!showWelcomeAnimation) {
      lottieRef.current?.destroy();
      lottieRef.current = null;
      return;
    }
    const canvas = lottieCanvasRef.current;
    if (!canvas) return;
    const animation = new DotLottie({
      canvas,
      src: hiLottie,
      autoplay: true,
      loop: true,
    });
    lottieRef.current = animation;
    return () => {
      animation.destroy();
      if (lottieRef.current === animation) {
        lottieRef.current = null;
      }
    };
  }, [showWelcomeAnimation]);

  const sendTextContent = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    const userId = crypto.randomUUID();
    const asstId = crypto.randomUUID();
    setMessages((m) => [
      ...m,
      { id: userId, role: 'user', content: text },
      { id: asstId, role: 'assistant', content: '', streaming: true },
    ]);
    abortRef.current = new AbortController();
    let lastAssistantSnapshot = '';
    try {
      await streamTextQuery(
        text,
        conversationId,
        (content) => {
          // 后端 chat 事件可能是“累计全文”；这里转成增量，避免每次覆盖导致不连贯。
          const delta = lastAssistantSnapshot && content.startsWith(lastAssistantSnapshot)
            ? content.slice(lastAssistantSnapshot.length)
            : content;
          if (!delta) return;
          lastAssistantSnapshot = content;
          setMessages((m) =>
            m.map((msg) => (msg.id === asstId ? { ...msg, content: msg.content + delta } : msg))
          );
        },
        abortRef.current.signal
      );
    } catch {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === asstId
            ? { ...msg, content: msg.content || '网络异常，请稍后重试', streaming: false }
            : msg
        )
      );
    } finally {
      setMessages((m) =>
        m.map((msg) => (msg.id === asstId ? { ...msg, streaming: false } : msg))
      );
      setSending(false);
    }
  }, [conversationId, sending, setMessages]);

  const sendText = useCallback(async () => {
    await sendTextContent(input);
  }, [input, sendTextContent]);

  const startPressToTalk = useCallback(() => {
    if (sending || recognitionRef.current) return;
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      console.warn('当前浏览器不支持语音识别');
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;

    speechFinalRef.current = '';
    speechInterimRef.current = '';
    speechReleasedRef.current = false;
    setIsListening(true);

    recognition.onresult = (event: any) => {
      let finalChunk = '';
      let interimChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = String(event.results[i][0]?.transcript ?? '').trim();
        if (!transcript) continue;
        if (event.results[i].isFinal) {
          finalChunk += transcript;
        } else {
          interimChunk += transcript;
        }
      }
      if (finalChunk) {
        speechFinalRef.current = `${speechFinalRef.current}${finalChunk}`;
      }
      speechInterimRef.current = interimChunk;
    };

    recognition.onerror = () => {
      setIsListening(false);
    };

    recognition.onend = () => {
      const recognized = `${speechFinalRef.current}${speechInterimRef.current}`.trim();
      const shouldSend = speechReleasedRef.current && !!recognized;
      setIsListening(false);
      recognitionRef.current = null;
      speechFinalRef.current = '';
      speechInterimRef.current = '';
      speechReleasedRef.current = false;
      if (shouldSend) {
        void sendTextContent(recognized);
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [sendTextContent, sending]);

  const stopPressToTalk = useCallback(() => {
    speechReleasedRef.current = true;
    setIsListening(false);
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
  }, [conversationId, input, sending, setMessages]);

  return (
    <div
      className="h-screen flex flex-col overflow-hidden bg-[#f5f7fa] text-[#1a1a1a] relative"
      style={{
        fontFamily:
          "'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans GB', 'Heiti SC', sans-serif",
      }}
    >
      {/* 顶栏 */}
      <header className="shrink-0 bg-[#f5f7fa] px-3 pt-3 pb-3 flex items-center gap-3">
        <div
          className="shrink-0 w-9 h-9 rounded-lg border border-dashed border-black/[0.25] bg-white text-[#333] text-[10px] tracking-wide flex items-center justify-center"
          aria-label="图标占位"
        >
          LOGO
        </div>
        <div className="flex-1 text-center pt-0.5">
          <button
            type="button"
            className="inline-flex items-center gap-0.5 text-[17px] font-semibold text-[#111]"
          >
            天府长岛元创助手
            {/* <ChevronDown className="w-4 h-4 text-[#888]" /> */}
          </button>
        </div>
        <div className="flex items-center gap-1 shrink-0 mt-0.5">
          <button
            type="button"
            onClick={async () => {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({
                  audio: { echoCancellation: true, noiseSuppression: true },
                });
                setPendingMicStream(stream);
              } catch (err) {
                console.warn('麦克风授权失败，进入实时页后将无法说话:', err);
              }
              onOpenVoice();
            }}
            className="p-2 rounded-full text-[#333] hover:bg-black/[0.05]"
            aria-label="实时语音"
          >
            <Phone className="w-6 h-6" strokeWidth={2} />
          </button>
        </div>
      </header>

      {/* 消息区 */}
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full min-h-[260px] flex items-center justify-center">
            {showWelcomeAnimation ? (
              <canvas
                ref={lottieCanvasRef}
                width={220}
                height={220}
                className="w-[200px] h-[200px]"
                aria-label="欢迎动画"
              />
            ) : null}
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'user' ? (
                <div
                  className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-relaxed text-white"
                  style={{
                    background: '#333333',
                  }}
                >
                  {msg.content}
                </div>
              ) : (
                <div className="max-w-[88%] rounded-2xl rounded-bl-md bg-[#f0f2f5] border border-black/[0.04] px-4 py-3 text-[15px] leading-relaxed text-[#222]">
                  <div className="whitespace-pre-wrap break-all" style={{ overflowWrap: 'anywhere' }}>
                    {msg.content || (msg.streaming ? '思考中...' : '')}
                    {msg.streaming ? (
                      <span className="inline-block w-1.5 h-4 ml-0.5 bg-black/[0.45] animate-pulse rounded-sm align-middle" />
                    ) : null}
                  </div>
                  {!msg.streaming && msg.content ? (
                    <div className="flex items-center gap-4 mt-3 pt-2 border-t border-black/[0.06] text-[#333]">
                      <button type="button" className="p-1 hover:opacity-70" aria-label="复制">
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* 快捷入口 */}
      <div
        className="shrink-0 px-3 pb-2 overflow-x-auto flex gap-2"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {QUICK_ACTIONS.map(({ label, icon: Icon }) => (
          <button
            key={label}
            type="button"
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-full border border-black/[0.08] bg-white text-[13px] text-[#444]"
          >
            <Icon className="w-4 h-4 text-[#333]" />
            {label}
          </button>
        ))}
      </div>

      {/* 底栏 */}
      <div className="shrink-0 bg-[#f5f7fa] px-3 pb-4 pt-2">
        <div className="flex items-center gap-2 rounded-[22px] border border-black/[0.08] bg-white px-2 py-2">
          <button
            type="button"
            className="p-2 rounded-full text-[#666] hover:bg-black/[0.05] shrink-0"
            aria-label="相机"
          >
            <Camera className="w-6 h-6" />
          </button>
          <div className="flex-1 min-w-0">
            {voiceMode ? (
              <button
                type="button"
                onMouseDown={startPressToTalk}
                onMouseUp={stopPressToTalk}
                onMouseLeave={() => {
                  if (isListening) stopPressToTalk();
                }}
                onTouchStart={(e) => {
                  startPressToTalk();
                }}
                onTouchEnd={(e) => {
                  stopPressToTalk();
                }}
                onTouchCancel={(e) => {
                  stopPressToTalk();
                }}
                disabled={sending}
                className={`w-full h-10 rounded-xl border text-sm font-medium transition ${
                  isListening
                    ? 'border-[#00a6c0] bg-[#e8f8fb] text-[#007b8f]'
                    : 'border-black/[0.1] bg-[#f7f7f7] text-[#555]'
                }`}
                aria-label={isListening ? '松开结束识别' : '按住说话'}
              >
                <span className="inline-flex items-center gap-1.5">
                  {isListening ? <AudioLines className="w-4 h-4 animate-pulse" /> : <Mic className="w-4 h-4" />}
                  {isListening ? '聆听中，松手发送' : '按住说话'}
                </span>
              </button>
            ) : (
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendText();
                  }
                }}
                placeholder="发消息…"
                disabled={sending}
                className="w-full h-10 leading-10 bg-transparent border-0 outline-none text-[15px] text-[#333] placeholder:text-[#999] px-1 py-0"
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              if (isListening) stopPressToTalk();
              setVoiceMode((v) => !v);
            }}
            className="p-2 rounded-full text-[#333] hover:bg-black/[0.05] shrink-0"
            aria-label={voiceMode ? '文字模式' : '语音模式'}
          >
            {voiceMode ? <Keyboard className="w-6 h-6" /> : <AudioLines className="w-6 h-6" />}
          </button>
          <button
            type="button"
            className="p-2 rounded-full text-[#666] hover:bg-black/[0.05] shrink-0"
            aria-label="更多"
          >
            <Plus className="w-6 h-6" />
          </button>
        </div>
      </div>
    </div>
  );
}
