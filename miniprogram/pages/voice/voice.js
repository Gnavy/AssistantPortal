/**
 * 实时语音页面 - 合并移植自:
 * - front/src/pages/VoiceRealtimePage.tsx
 * - front/src/hooks/useLiveAPI.ts
 *
 * 核心功能：WebSocket 双向音频 + 防回声 + VAD打断 + 字幕显示
 */
var { WxWebSocket } = require('../../utils/websocket');
var { PCMPlayer } = require('../../utils/audio-player');
var { AudioRecorder } = require('../../utils/audio-recorder');
var { resolveRealtimeWsUrl } = require('../../utils/api');
var { releaseWebSocket } = require('../../utils/ws-release');
var { generateUUID } = require('../../utils/uuid');
var app = getApp();

// Lottie 动画片段帧数
var SEGMENT_INTRO = [2, 60];
var SEGMENT_LOOP = [61, 230];
var SEGMENT_HANGUP = [310, 360];

// 常量
var OUTPUT_SAMPLE_RATE = 24000;
var BYTES_PER_SAMPLE = 2;
var DISPLAY_CHARS_PER_SECOND = 5.5;
var MAX_REVEAL_CHARS_PER_TICK = 3;
var CONNECTION_TIMEOUT_MS = 8000;
var BRIDGE_READY_TIMEOUT_MS = 25000;
var AUTO_CONNECT_DELAY_MS = 150;
var INTERRUPT_MIN_PLAYING_MS = 200;
var INTERRUPT_CONFIRM_WINDOW_MS = 700;
var INTERRUPT_REQUIRE_SECOND_CONFIRM = true;
var INTERRUPT_STRONG_VOICE_MS = 220;
var LOCAL_INTERRUPT_DROP_AUDIO_MS = 1500;
var INTERRUPT_RECENT_AUDIO_MS = 1800;
var TURN_STALL_TIMEOUT_MS = 8000;
var VAD_TUNING = {
  threshold: 0.038,
  cooldownMs: 900,
  minActiveFrames: 2,
  minVoiceMs: 140,
  noiseWindowFrames: 50,
  noiseFloorRatio: 1.5,
};
var ENABLE_VAD_DEBUG_LOG = true;

function uint8ToBinary(bytes) {
  var CHUNK = 0x8000;
  var parts = [];
  for (var i = 0; i < bytes.length; i += CHUNK) {
    var sub = bytes.subarray(i, i + CHUNK);
    parts.push(String.fromCharCode.apply(null, sub));
  }
  return parts.join('');
}

function decodeUtf8ArrayBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer)) return '';
  try {
    return decodeURIComponent(escape(uint8ToBinary(new Uint8Array(buffer))));
  } catch (e) {
    return '';
  }
}

Page({
  data: {
    connectionState: 'disconnected',
    errorMessage: '',
    isConnected: false,
    isError: false,
    titleText: '连接中',
    statusText: '',
    latestUserText: '',
    modelText: '',
    isThinking: false,
    avatarLottiePath: '/assets/avatar.json',
    avatarLottieLoop: false,
  },

  // === 内部状态（不响应式，对应 React useRef） ===
  _ws: null,
  _player: null,
  _recorder: null,
  _session: 0,
  _callActive: false,
  _bridgeReadyHandled: false,
  _prematureBridgeCloseCount: 0,

  // 字幕相关
  _pendingModelText: '',
  _revealBudget: 0,
  _audioTimeBudget: 0,
  _lastModelContent: '',
  _modelStreamActive: false,
  _lastModelContentAt: 0,
  _currentTurnModelText: '',
  _activeTurnId: '',
  _activeTurnSource: '',
  _activeAssistantPhase: 'final',
  _activeTurnUserText: '',
  _lastFinalUserAsr: '',

  // 防回声
  _assistantMicSquelchUntil: 0,
  _lastPlayerPlaying: false,
  _lastInterruptAt: 0,
  _playerStartedAt: 0,
  _pendingInterruptConfirmAt: 0,
  _dropInboundAudioUntil: 0,
  _lastInboundAudioAt: 0,
  _micBypassSquelchUntil: 0,
  _lastTurnActivityAt: 0,

  // 去重
  _lastAssistantFinalDoneTurnId: null,
  _lastCommittedVoiceReply: null,

  // 定时器
  _revealTimer: null,
  _connectTimeout: null,
  _bridgeReadyTimeout: null,
  _autoRetryTimer: null,
  _keepAliveTimer: null,
  _turnWatchdogTimer: null,

  // 语音消息累积
  _pendingVoiceMessages: [],
  _isHangingUp: false,

  // Lottie
  _lottieReady: false,
  _lottieComponent: null,
  _awaitingIntroComplete: false,
  _connectionPhase: 'idle',
  _shouldReconnectOnShow: false,
  _isPageVisible: false,

  onLoad: function () {
    this._isPageVisible = true;
    this._conversationId = app.globalData.conversationId;
    this._setAvatarAnim('intro');
    this._connectWithPermission();
  },

  onShow: function () {
    this._isPageVisible = true;
    if (!this._shouldReconnectOnShow || this._isHangingUp) return;
    this._shouldReconnectOnShow = false;
    this._debug('lifecycle_onShow_reconnect');
    this._connectWithPermission();
  },

  onHide: function () {
    this._isPageVisible = false;
    if (this._isHangingUp) return;
    var needReconnect =
      !!this._ws ||
      this.data.connectionState === 'connected' ||
      this.data.connectionState === 'connecting';
    if (!needReconnect) return;
    this._debug('lifecycle_onHide_disconnect');
    this._shouldReconnectOnShow = true;
    this._disconnect();
  },

  onUnload: function () {
    this._isPageVisible = false;
    this._shouldReconnectOnShow = false;
    this._disconnect();
  },

  _connectWithPermission: function () {
    var self = this;
    this._ensureRecordPermission(function (granted, reason) {
      if (!granted) {
        self._connectionPhase = 'permission_denied';
        self._setError(
          reason ||
            '未开启麦克风权限，请在小程序设置中允许录音后重试'
        );
        return;
      }
      setTimeout(function () {
        if (!self._isPageVisible || self._isHangingUp) return;
        self._connectionPhase = 'connecting';
        self._connect();
      }, AUTO_CONNECT_DELAY_MS);
    });
  },

  // ============================================================
  // 连接管理
  // ============================================================

  _connect: function (opts) {
    opts = opts || {};
    var self = this;
    var conversationId = this._conversationId;

    if (this._ws) return;

    if (!opts.fromAutoRetry) {
      this._prematureBridgeCloseCount = 0;
    }

    this._cleanup();
    this._session += 1;
    var session = this._session;

    this._setState('connecting');
    this._connectionPhase = 'connecting';
    this._debug('phase', { phase: this._connectionPhase });
    this._isHangingUp = false;
    this._bridgeReadyHandled = false;

    // 创建播放器和录音器
    this._player = new PCMPlayer(
      function () {
        // volume callback - 小程序无法实现，空操作
      },
      function (err) {
        self._onPlayerFatal(err);
      }
    );

    if (!this._player.isAvailable || !this._player.isAvailable()) {
      var initErr =
        (this._player.getInitError && this._player.getInitError()) ||
        '播放器初始化失败';
      this._setError('音频播放不可用: ' + initErr);
      this._connectionPhase = 'player_failed';
      this._debug('player_init_fail', { errMsg: initErr });
      this._cleanup();
      return;
    }

    if (!this._recorder) {
      this._recorder = new AudioRecorder({
        vad: VAD_TUNING,
        debug: ENABLE_VAD_DEBUG_LOG,
        onData: function (base64Data) {
          if (!self._ws || self._ws.readyState !== 1) return; // OPEN

          // 防回声：播放中/播放后短窗内丢弃麦克风帧
          var player = self._player;
          var now = Date.now();
          var playing = player ? player.isPlaying() : false;

        if (playing && !self._lastPlayerPlaying) {
          self._playerStartedAt = now;
        }
          if (self._lastPlayerPlaying && !playing) {
            self._assistantMicSquelchUntil = now + 600;
          self._playerStartedAt = 0;
          }
          self._lastPlayerPlaying = playing;

          var bypassSquelch = now < self._micBypassSquelchUntil;
          if (!bypassSquelch && (playing || now < self._assistantMicSquelchUntil)) return;

          // base64 -> ArrayBuffer -> 发送
          var bytes = wx.base64ToArrayBuffer(base64Data);
          self._ws.send(bytes);
        },
        onVoiceActivity: function (vadMeta) {
          var now = Date.now();
          self._assistantMicSquelchUntil = 0;

          if (!self._ws || self._ws.readyState !== 1) return;
          var playerPlaying = !!(self._player && self._player.isPlaying());
          var hasAudioBudget = self._audioTimeBudget > 0.08;
          var hasRecentInboundAudio =
            self._lastInboundAudioAt > 0 &&
            now - self._lastInboundAudioAt <= INTERRUPT_RECENT_AUDIO_MS;
          if (!playerPlaying && !hasAudioBudget && !hasRecentInboundAudio) {
            self._debug('interrupt_reject_not_playing', {
              vadMeta: vadMeta || {},
              playerPlaying: playerPlaying,
              hasAudioBudget: hasAudioBudget,
              audioTimeBudget: self._audioTimeBudget,
              msSinceInboundAudio: self._lastInboundAudioAt
                ? now - self._lastInboundAudioAt
                : -1,
            });
            return;
          }

          var speechMs = Number((vadMeta && vadMeta.speechMs) || 0);
          var playedMs = self._playerStartedAt
            ? now - self._playerStartedAt
            : 0;
          var strongVoice = speechMs >= INTERRUPT_STRONG_VOICE_MS;
          var stablePlaying = playedMs >= INTERRUPT_MIN_PLAYING_MS;

          if (!stablePlaying && !strongVoice) {
            self._debug('interrupt_reject', {
              reason: 'player_not_stable',
              playedMs: playedMs,
              minPlayingMs: INTERRUPT_MIN_PLAYING_MS,
              speechMs: speechMs,
            });
            // 播放未稳定时降级为二次确认，而不是直接拒绝，避免长期无法打断
            self._pendingInterruptConfirmAt = now;
          }

          if (strongVoice) {
            self._debug('interrupt_allow_strong_voice', {
              speechMs: speechMs,
              playedMs: playedMs,
            });
          } else if (INTERRUPT_REQUIRE_SECOND_CONFIRM) {
            if (
              !self._pendingInterruptConfirmAt ||
              now - self._pendingInterruptConfirmAt > INTERRUPT_CONFIRM_WINDOW_MS
            ) {
              self._pendingInterruptConfirmAt = now;
              self._debug('interrupt_confirm_armed', {
                vadMeta: vadMeta || {},
                windowMs: INTERRUPT_CONFIRM_WINDOW_MS,
              });
              return;
            }
            self._debug('interrupt_allow_confirmed', {
              speechMs: speechMs,
              playedMs: playedMs,
              confirmDeltaMs: now - self._pendingInterruptConfirmAt,
            });
          }

          if (now - self._lastInterruptAt < 500) {
            self._debug('interrupt_reject_throttle', {
              deltaMs: now - self._lastInterruptAt,
            });
            return;
          }
          self._lastInterruptAt = now;
          self._pendingInterruptConfirmAt = 0;
          self._dropInboundAudioUntil = now + LOCAL_INTERRUPT_DROP_AUDIO_MS;
          self._micBypassSquelchUntil = now + 1200;

          self._player.stop();
          self._audioTimeBudget = 0;
          self._ws.send(JSON.stringify({ type: 'interrupt' }));
        },
        onStart: function () {
          self._debug('recorder_start_ok');
        },
        onFatal: function (err) {
          self._onRecorderFatal(err);
        },
      });
    }

    // 创建 WebSocket
    var wsUrl = resolveRealtimeWsUrl(conversationId);
    var ws = new WxWebSocket(wsUrl);
    this._ws = ws;

    // 连接超时
    this._connectTimeout = setTimeout(function () {
      if (session !== self._session) return;
      if (ws.readyState !== 1) {
        self._setError('连接超时，请检查后端服务是否正常运行');
        releaseWebSocket(ws);
        self._ws = null;
        self._cleanup();
      }
    }, CONNECTION_TIMEOUT_MS);

    // WS 事件
    ws.onopen = function () {
      if (session !== self._session) return;
      self._debug('ws_open', { wsUrl: wsUrl });
      if (self._connectTimeout) {
        clearTimeout(self._connectTimeout);
        self._connectTimeout = null;
      }

      ws.send(
        JSON.stringify({
          type: 'set_conversation_id',
          conversation_id: conversationId,
        })
      );

      // 等待 bridge_ready
      self._bridgeReadyTimeout = setTimeout(function () {
        if (session !== self._session) return;
        if (self.data.connectionState === 'connecting') {
          self._setError(
            '与豆包上游握手超时，请检查服务端网络、config 与鉴权'
          );
          releaseWebSocket(ws);
          self._ws = null;
          self._cleanup();
        }
      }, BRIDGE_READY_TIMEOUT_MS);
    };

    ws.onmessage = function (event) {
      if (session !== self._session) return;
      self._handleMessage(event.data);
    };

    ws.onerror = function (err) {
      if (session !== self._session) return;
      var rawErrMsg = (err && err.errMsg) || '';
      self._debug('ws_error', { errMsg: rawErrMsg });
      self._failAndRelease(
        'WebSocket 连接失败，请检查后端服务是否运行在 ' +
          wsUrl +
          (rawErrMsg ? '；错误：' + rawErrMsg : ''),
        'ws_error'
      );
    };

    ws.onclose = function (event) {
      if (session !== self._session) return;
      self._debug('ws_close', {
        code: event && event.code,
        reason: event && event.reason,
        phase: self._connectionPhase,
      });
      self._handleClose(event);
    };

    // 发起连接
    ws.connect();
  },

  _disconnect: function () {
    this._callActive = false;
    this._session += 1;

    if (this._autoRetryTimer) {
      clearTimeout(this._autoRetryTimer);
      this._autoRetryTimer = null;
    }
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
    if (this._turnWatchdogTimer) {
      clearInterval(this._turnWatchdogTimer);
      this._turnWatchdogTimer = null;
    }

    var w = this._ws;
    this._ws = null;
    releaseWebSocket(w);
    this._cleanup();

    this._setState('disconnected');
    this._connectionPhase = 'disconnected';
    this._setAvatarAnim('intro');
    this._resetAvatarToIntroFrame();
    this._prematureBridgeCloseCount = 0;
    this.setData({ errorMessage: '' });
    this._flushReveal(true);
    this._modelStreamActive = false;
    this._lastModelContent = '';
    this._lastInterruptAt = 0;
    this._playerStartedAt = 0;
    this._pendingInterruptConfirmAt = 0;
    this._dropInboundAudioUntil = 0;
    this._lastInboundAudioAt = 0;
    this._micBypassSquelchUntil = 0;
    this._lastTurnActivityAt = 0;
  },

  _cleanup: function () {
    if (this._recorder) {
      this._recorder.stop();
    }
    if (this._player) {
      this._player.close();
      this._player = null;
    }
    if (this._revealTimer) {
      clearInterval(this._revealTimer);
      this._revealTimer = null;
    }
    if (this._connectTimeout) {
      clearTimeout(this._connectTimeout);
      this._connectTimeout = null;
    }
    if (this._bridgeReadyTimeout) {
      clearTimeout(this._bridgeReadyTimeout);
      this._bridgeReadyTimeout = null;
    }
    if (this._autoRetryTimer) {
      clearTimeout(this._autoRetryTimer);
      this._autoRetryTimer = null;
    }
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
    if (this._turnWatchdogTimer) {
      clearInterval(this._turnWatchdogTimer);
      this._turnWatchdogTimer = null;
    }

    this._bridgeReadyHandled = false;
    this._callActive = false;
    this._pendingModelText = '';
    this._revealBudget = 0;
    this._audioTimeBudget = 0;
    this._modelStreamActive = false;
    this._lastModelContentAt = 0;
    this._lastInterruptAt = 0;
    this._currentTurnModelText = '';
    this._activeTurnId = '';
    this._activeTurnSource = '';
    this._activeAssistantPhase = 'final';
    this._activeTurnUserText = '';
    this._lastFinalUserAsr = '';
    this._assistantMicSquelchUntil = 0;
    this._lastPlayerPlaying = false;
    this._micBypassSquelchUntil = 0;
    this._lastTurnActivityAt = 0;
    this._lastCommittedVoiceReply = null;
    this._lastAssistantFinalDoneTurnId = null;
    this._connectionPhase = 'idle';
  },

  // ============================================================
  // 消息处理
  // ============================================================

  _handleMessage: function (data) {
    var self = this;
    var nowTs = Date.now();
    this._lastTurnActivityAt = nowTs;

    // 二进制音频数据
    if (data instanceof ArrayBuffer) {
      var textMaybe = decodeUtf8ArrayBuffer(data);
      if (textMaybe) {
        var firstChar = textMaybe.charAt(0);
        if (firstChar === '{' || firstChar === '[') {
          data = textMaybe;
        }
      }
    }

    if (data instanceof ArrayBuffer) {
      var bytes = new Uint8Array(data);
      if (Date.now() < this._dropInboundAudioUntil) {
        return;
      }
      this._lastInboundAudioAt = nowTs;
      var base64Audio = wx.arrayBufferToBase64(data);

      if (this._player) {
        this._player.play(base64Audio);
      }

      // 更新防回声时间
      var seconds = bytes.byteLength / (OUTPUT_SAMPLE_RATE * BYTES_PER_SAMPLE);
      var now = Date.now();
      this._assistantMicSquelchUntil = Math.max(
        this._assistantMicSquelchUntil,
        now + seconds * 1000 + 2500
      );
      this._audioTimeBudget += seconds;
      return;
    }

    // JSON 文本消息
    if (typeof data === 'string') {
      try {
        var payload = JSON.parse(data);
      } catch (e) {
        return;
      }

      if (payload.type === 'bridge_ready') {
        this._debug('bridge_ready');
        this._onBridgeReady();
        return;
      }
      if (payload.type === 'bridge_error') {
        this._clearBridgeTimeout();
        this._setError(payload.message || '上游连接失败');
        releaseWebSocket(this._ws);
        this._ws = null;
        this._cleanup();
        return;
      }
      if (payload.type === 'upstream_error') {
        this._clearBridgeTimeout();
        this._setError(payload.message || '上游服务返回错误');
        releaseWebSocket(this._ws);
        this._ws = null;
        this._cleanup();
        return;
      }
      if (payload.type === 'upstream_closed') {
        this._clearBridgeTimeout();
        this._setError(payload.message || '上游连接已关闭');
        releaseWebSocket(this._ws);
        this._ws = null;
        this._cleanup();
        return;
      }
      if (payload.type === 'turn_start') {
        this._lastTurnActivityAt = Date.now();
        this._activeTurnId = payload.turn_id || '';
        this._activeTurnSource = payload.source || '';
        this._activeTurnUserText = payload.user_text || '';
        this._activeAssistantPhase = 'final';
        if (payload.source === 'voice') {
          this._lastFinalUserAsr = '';
          this.setData({ latestUserText: '' });
        }
        this._resetTurnBuffers();
        this.setData({ modelText: '' });
        return;
      }
      if (payload.type === 'turn_cancelled') {
        var cancelledTurnId = payload.turn_id || '';
        if (
          cancelledTurnId &&
          this._activeTurnId &&
          cancelledTurnId !== this._activeTurnId
        ) {
          this._debug('turn_cancelled_ignored_mismatch', {
            activeTurnId: this._activeTurnId,
            cancelledTurnId: cancelledTurnId,
          });
          return;
        }
        this._debug('turn_cancelled', {
          turnId: cancelledTurnId,
          reason: payload.reason || '',
        });
        this._finalizeActiveTurn();
        return;
      }
      if (payload.type === 'assistant_phase') {
        this._lastTurnActivityAt = Date.now();
        this._activeAssistantPhase = payload.phase || 'final';
        if (payload.phase === 'comfort') {
          this._audioTimeBudget = 0;
          this._resetTurnBuffers();
        } else if (payload.phase === 'final') {
          this._resetTurnBuffers();
        }
        return;
      }
      if (payload.type === 'assistant_text') {
        this._lastTurnActivityAt = Date.now();
        if (payload.phase !== 'final') return;
        if (typeof payload.content === 'string' && payload.content) {
          this._appendModelDelta(payload.content);
        }
        return;
      }
      if (payload.type === 'assistant_final_done') {
        this._lastTurnActivityAt = Date.now();
        var doneTurnId = payload.turn_id || '';
        if (
          doneTurnId &&
          this._activeTurnId &&
          doneTurnId !== this._activeTurnId
        ) {
          this._debug('assistant_final_done_ignored_mismatch', {
            activeTurnId: this._activeTurnId,
            doneTurnId: doneTurnId,
          });
          return;
        }
        this._assistantMicSquelchUntil = Math.max(
          this._assistantMicSquelchUntil,
          Date.now() + 2500
        );
        this._audioTimeBudget +=
          this._pendingModelText.length / DISPLAY_CHARS_PER_SECOND;
        this._flushReveal(true);

        var finalReply = this._currentTurnModelText.trim();
        var shouldSkip =
          doneTurnId &&
          this._lastAssistantFinalDoneTurnId === doneTurnId;

        if (doneTurnId && !shouldSkip) {
          this._lastAssistantFinalDoneTurnId = doneTurnId;
        }

        var userLine =
          (payload.user_text || '').trim() ||
          (this._activeTurnSource === 'voice'
            ? this._lastFinalUserAsr.trim()
            : this._activeTurnUserText.trim()) ||
          undefined;

        if (
          !shouldSkip &&
          finalReply
        ) {
          var now = Date.now();
          var userKey = (userLine || '').trim();
          var assistantKey = finalReply.trim();
          var lastCommitted = this._lastCommittedVoiceReply;
          var isDuplicate =
            lastCommitted &&
            lastCommitted.user === userKey &&
            lastCommitted.assistant === assistantKey &&
            now - lastCommitted.ts < 8000;

          if (!isDuplicate) {
            this._commitVoiceReply(finalReply, userLine);
            this._lastCommittedVoiceReply = {
              user: userKey,
              assistant: assistantKey,
              ts: now,
            };
          }
        }

        this._finalizeActiveTurn();
        return;
      }
      if (payload.type === 'voice_input_ignored') {
        this._debug('voice_input_ignored', payload);
        return;
      }
      if (payload.type === 'interrupt_policy') {
        var policyTurnId = payload.turn_id || '';
        if (
          payload.applied_client_interrupt &&
          (!policyTurnId || !this._activeTurnId || policyTurnId === this._activeTurnId)
        ) {
          this._finalizeActiveTurn();
          this._setState('connected');
        }
        this._debug('interrupt_policy', payload);
        return;
      }

      // ASR 事件
      var ev = payload.event;
      if (ev === 450) {
        this._lastTurnActivityAt = Date.now();
        this._resetTurnBuffers();
        this._lastFinalUserAsr = '';
        this.setData({ modelText: '' });
      } else if (ev === 451) {
        this._lastTurnActivityAt = Date.now();
        var r0 = payload.results && payload.results[0];
        if (r0 && r0.text) {
          var text = String(r0.text);
          this._mergeUserAsrDisplay(text);
          if (!r0.is_interim) {
            this._lastFinalUserAsr = text.trim();
            this._micBypassSquelchUntil = 0;
          }
        }
      } else if (
        this._activeAssistantPhase === 'final' &&
        typeof payload.content === 'string' &&
        payload.content &&
        (ev === undefined || ev === null || ev === 550)
      ) {
        this._appendModelDelta(payload.content);
      }
    }
  },

  _handleClose: function (event) {
    if (this._bridgeReadyTimeout) {
      clearTimeout(this._bridgeReadyTimeout);
      this._bridgeReadyTimeout = null;
    }

    var connectingNoBridge =
      this.data.connectionState === 'connecting' &&
      !this._bridgeReadyHandled;

    this._flushReveal(true);
    this._modelStreamActive = false;
    this._lastModelContent = '';
    this._lastInterruptAt = 0;

    if (connectingNoBridge) {
      this._prematureBridgeCloseCount += 1;
      if (this._prematureBridgeCloseCount <= 1) {
        this._setState('connecting');
        this.setData({ errorMessage: '' });
        var self = this;
        if (this._autoRetryTimer) {
          clearTimeout(this._autoRetryTimer);
        }
        this._autoRetryTimer = setTimeout(function () {
          self._autoRetryTimer = null;
          self._connect({ fromAutoRetry: true });
        }, 200);
        return;
      }
    }

    // Cleanup
    var w = this._ws;
    this._ws = null;
    releaseWebSocket(w);
    this._cleanup();

    if (this.data.connectionState === 'connecting') {
      this._setError(
        '连接被关闭: ' +
          (event.reason || '未知原因') +
          ' (code: ' +
          (event.code || '') +
          ')'
      );
    } else if (this.data.connectionState !== 'error') {
      this._setState('disconnected');
      this._setAvatarAnim('intro');
      this._resetAvatarToIntroFrame();
    }
  },

  // ============================================================
  // bridge_ready 后启动麦克风
  // ============================================================

  _onBridgeReady: function () {
    if (this._bridgeReadyHandled) return;
    this._bridgeReadyHandled = true;
    this._connectionPhase = 'bridge_ready';
    this._prematureBridgeCloseCount = 0;

    if (this._bridgeReadyTimeout) {
      clearTimeout(this._bridgeReadyTimeout);
      this._bridgeReadyTimeout = null;
    }

    var self = this;
    var session = this._session;

    this._setState('connected');
    this._startTurnWatchdog(session);

    // 心跳
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
    this._keepAliveTimer = setInterval(function () {
      if (session !== self._session) return;
      if (!self._ws || self._ws.readyState !== 1) return;
      self._ws.send(JSON.stringify({ type: 'keep_alive' }));
    }, 8000);

    this._startMicAfterBridge(session, self);
  },

  /** Lottie 资源加载完成 */
  onAvatarLottieReady: function () {
    this._lottieReady = true;
    if (this.data.isConnected && !this._isHangingUp) {
      this._runAvatarIntroThenLoop();
      return;
    }
    this._resetAvatarToIntroFrame();
  },

  /** intro 播放完成后切 loop（仅连接态有效） */
  onAvatarLottieComplete: function () {
    if (!this._awaitingIntroComplete) return;
    this._awaitingIntroComplete = false;
    if (!this.data.isConnected || this._isHangingUp) return;
    this._playLottieSegment(SEGMENT_LOOP, true);
  },

  // ============================================================
  // 字幕管理
  // ============================================================

  _appendModelDelta: function (content) {
    if (!content) return;
    var now = Date.now();
    var lastContent = this._lastModelContent;
    var isContinuousStream =
      this._modelStreamActive && now - this._lastModelContentAt < 2500;
    var delta =
      isContinuousStream && lastContent && content.indexOf(lastContent) === 0
        ? content.slice(lastContent.length)
        : content;

    if (!delta) return;
    this._modelStreamActive = true;
    this._lastModelContentAt = now;
    this._lastModelContent = content;
    this._pendingModelText += delta;
    this._currentTurnModelText += delta;
  },

  /** 与 front useLiveAPI appendModelVisibleDelta 对齐：前缀替换、后缀重叠合并 */
  _appendModelVisibleDelta: function (text) {
    var t = (text || '').trim();
    if (!t) return;

    var currentModelText = this.data.modelText || '';

    if (currentModelText === t) {
      this._updateThinking();
      return;
    }

    if (t.indexOf(currentModelText) === 0) {
      this.setData({ modelText: t });
      this._updateThinking();
      return;
    }

    if (currentModelText.indexOf(t) === 0) {
      this._updateThinking();
      return;
    }

    var maxOverlap = Math.min(currentModelText.length, t.length);
    var overlap = 0;
    for (var k = maxOverlap; k >= 1; k--) {
      if (currentModelText.slice(-k) === t.slice(0, k)) {
        overlap = k;
        break;
      }
    }
    var merged = currentModelText + t.slice(overlap);
    if (merged === currentModelText) {
      this._updateThinking();
      return;
    }
    this.setData({ modelText: merged });
    this._updateThinking();
  },

  _mergeUserAsrDisplay: function (text) {
    var t = text.trim();
    if (!t) return;
    this.setData({ latestUserText: t });
    this._updateThinking();
  },

  _tickReveal: function () {
    if (this._audioTimeBudget <= 0) return;
    var tickSeconds = Math.min(this._audioTimeBudget, 0.1);
    this._audioTimeBudget -= tickSeconds;
    this._revealBudget += tickSeconds * DISPLAY_CHARS_PER_SECOND;
    this._flushReveal(false, MAX_REVEAL_CHARS_PER_TICK);
  },

  _flushReveal: function (forceAll, maxChars) {
    var pending = this._pendingModelText;
    if (!pending) return;

    if (forceAll) {
      this._appendModelVisibleDelta(pending);
      this._pendingModelText = '';
      this._revealBudget = 0;
      return;
    }

    maxChars = maxChars || Number.POSITIVE_INFINITY;
    var revealChars = Math.min(Math.floor(this._revealBudget), maxChars);
    if (revealChars <= 0) return;

    var chunk = pending.slice(0, revealChars);
    if (!chunk) return;

    this._appendModelVisibleDelta(chunk);
    this._pendingModelText = pending.slice(chunk.length);
    this._revealBudget = Math.max(0, this._revealBudget - chunk.length);
  },

  _resetTurnBuffers: function () {
    this._pendingModelText = '';
    this._revealBudget = 0;
    this._currentTurnModelText = '';
    this._modelStreamActive = false;
    this._lastModelContent = '';
    this._lastModelContentAt = 0;
  },

  _finalizeActiveTurn: function () {
    this._resetTurnBuffers();
    this._activeAssistantPhase = 'final';
    this._activeTurnId = '';
    this._activeTurnSource = '';
    this._activeTurnUserText = '';
    this._lastFinalUserAsr = '';
    this._micBypassSquelchUntil = 0;
    this._lastTurnActivityAt = 0;
  },

  _startTurnWatchdog: function (session) {
    var self = this;
    if (this._turnWatchdogTimer) {
      clearInterval(this._turnWatchdogTimer);
      this._turnWatchdogTimer = null;
    }
    this._turnWatchdogTimer = setInterval(function () {
      if (session !== self._session) return;
      if (!self._ws || self._ws.readyState !== 1) return;
      if (!self._callActive) return;
      if (!self._activeTurnId) return;
      if (!self._lastTurnActivityAt) {
        self._lastTurnActivityAt = Date.now();
        return;
      }
      var stalledMs = Date.now() - self._lastTurnActivityAt;
      if (stalledMs < TURN_STALL_TIMEOUT_MS) return;
      self._debug('turn_watchdog_recover', {
        stalledMs: stalledMs,
        turnId: self._activeTurnId,
      });
      self._lastTurnActivityAt = Date.now();
      self._dropInboundAudioUntil = Date.now() + 500;
      self._audioTimeBudget = 0;
      if (self._player) {
        self._player.stop();
      }
      self._ws.send(JSON.stringify({ type: 'interrupt' }));
      self._setState('connected');
    }, 1000);
  },

  _updateThinking: function () {
    var isConnected = this.data.isConnected;
    var connectionState = this.data.connectionState;
    var modelText = this.data.modelText;
    var latestUserText = this.data.latestUserText;
    var isThinking =
      isConnected &&
      connectionState !== 'error' &&
      latestUserText &&
      !modelText;
    this.setData({ isThinking: !!isThinking });
  },

  // ============================================================
  // 语音消息回传
  // ============================================================

  _commitVoiceReply: function (assistantText, userTranscript) {
    var assistant = assistantText.trim();
    if (!assistant) return;

    var user = userTranscript ? userTranscript.trim() : '';

    if (user) {
      this._pendingVoiceMessages.push(
        {
          id: generateUUID(),
          role: 'user',
          content: user,
          voice: true,
        },
        {
          id: generateUUID(),
          role: 'assistant',
          content: assistant,
        }
      );
    } else {
      this._pendingVoiceMessages.push({
        id: generateUUID(),
        role: 'assistant',
        content: assistant,
      });
    }

    // 同步到全局
    for (var i = 0; i < this._pendingVoiceMessages.length; i++) {
      app.addPendingVoiceMessage(this._pendingVoiceMessages[i]);
    }
    this._pendingVoiceMessages = [];
  },

  // ============================================================
  // UI 交互
  // ============================================================

  handleHangup: function () {
    if (this._isHangingUp) return;
    this._isHangingUp = true;

    // 播放挂断 Lottie
    this._playLottieSegment(SEGMENT_HANGUP, false);

    // 播放挂断提示音
    this._playChime('/assets/hangup.wav');

    this._disconnect();
    this._setAvatarAnim('intro');
    wx.navigateBack();
  },

  handleRetry: function () {
    this._disconnect();
    var self = this;
    setTimeout(function () {
      self._connect();
    }, 100);
  },

  // ============================================================
  // Lottie 动画控制
  // ============================================================


  _setAvatarAnim: function (mode) {
    var path = '/assets/avatar.json';
    this.setData({
      avatarLottiePath: path,
      avatarLottieLoop: false,
    });
  },

  _playLottieIntro: function () {
    // 已改为两文件切换，不再做单文件分段。保留空实现兼容历史调用。
  },

  _runAvatarIntroThenLoop: function () {
    var lottie = this._getLottieComponent();
    if (!lottie || !this._lottieReady || this._isHangingUp) return;
    this._awaitingIntroComplete = true;
    this._playLottieSegment(SEGMENT_INTRO, false);
  },

  _resetAvatarToIntroFrame: function () {
    var lottie = this._getLottieComponent();
    if (!lottie) return;
    this._awaitingIntroComplete = false;
    lottie.stop();
    lottie.setLoop(false);
    lottie.setFrame(SEGMENT_INTRO[0]);
  },

  _playLottieSegment: function (segment, loop) {
    var lottie = this._getLottieComponent();
    if (!lottie) return;
    lottie.playSegment(segment[0], segment[1], loop);
  },

  _getLottieComponent: function () {
    if (this._lottieComponent) return this._lottieComponent;
    this._lottieComponent = this.selectComponent('#avatar-lottie');
    return this._lottieComponent;
  },

  // ============================================================
  // 提示音
  // ============================================================

  _playChime: function (src) {
    try {
      var audio = wx.createInnerAudioContext();
      audio.src = src;
      audio.volume = 0.3;
      audio.onEnded = function () {
        audio.destroy();
      };
      audio.onError = function () {
        audio.destroy();
      };
      audio.play();
    } catch (e) {
      // ignore
    }
  },

  _startMicAfterBridge: function (session, self) {
    self = self || this;
    if (!this._recorder || typeof this._recorder.start !== 'function') {
      this._setError('麦克风不可用: recorder 未初始化');
      this._connectionPhase = 'mic_missing';
      return;
    }
    this._connectionPhase = 'mic_starting';
    this._debug('phase', { phase: this._connectionPhase });
    this._recorder
      .start()
      .then(function () {
        if (session !== self._session) return;
        self._connectionPhase = 'listening';
        self._callActive = true;
        self._pendingInterruptConfirmAt = 0;
        self._dropInboundAudioUntil = 0;
        self._lastInboundAudioAt = 0;
        self._micBypassSquelchUntil = 0;
        self._lastTurnActivityAt = 0;
        self._debug('phase', { phase: self._connectionPhase });
        self._playChime('/assets/connect.wav');
        if (self._revealTimer) {
          clearInterval(self._revealTimer);
        }
        self._revealTimer = setInterval(function () {
          self._tickReveal();
        }, 100);
        self._runAvatarIntroThenLoop();
      })
      .catch(function (err) {
        if (session !== self._session) return;
        var startErr = (err && (err.errMsg || err.message)) || String(err);
        self._connectionPhase = 'mic_failed';
        self._debug('recorder_start_fail', { errMsg: startErr });
        self._failAndRelease(
          '麦克风启动失败: ' +
            startErr +
            '。请确认已授权录音权限并关闭其他占用麦克风的应用',
          'mic_start_fail'
        );
      });
  },

  _onRecorderFatal: function (err) {
    var msg = (err && err.errMsg) || (err && err.message) || 'unknown';
    this._debug('recorder_fatal', { errMsg: msg, phase: this._connectionPhase });
    this._connectionPhase = 'recorder_fatal';
    this._failAndRelease('录音器异常: ' + msg, 'recorder_fatal');
  },

  _onPlayerFatal: function (err) {
    var msg = (err && err.errMsg) || (err && err.message) || 'unknown';
    this._debug('player_fatal', { errMsg: msg, phase: this._connectionPhase });
    this._connectionPhase = 'player_fatal';
    this._failAndRelease('播放器异常: ' + msg, 'player_fatal');
  },

  _debug: function (event, extra) {
    try {
      console.info('[voice-debug]', event, extra || {});
    } catch (e) {}
  },

  _failAndRelease: function (message, stage) {
    this._setError(message);
    this._debug('fail_and_release', { stage: stage || '', message: message });
    var w = this._ws;
    this._ws = null;
    releaseWebSocket(w);
    this._cleanup();
  },

  _ensureRecordPermission: function (done) {
    done = typeof done === 'function' ? done : function () {};
    wx.getSetting({
      success: function (res) {
        var setting = (res && res.authSetting) || {};
        if (setting['scope.record']) {
          done(true);
          return;
        }
        wx.authorize({
          scope: 'scope.record',
          success: function () {
            done(true);
          },
          fail: function (err) {
            var msg = (err && err.errMsg) || '';
            done(false, '录音权限未授权（' + msg + '）');
          },
        });
      },
      fail: function (err) {
        done(false, '无法读取权限状态: ' + ((err && err.errMsg) || 'unknown'));
      },
    });
  },

  // ============================================================
  // 状态管理
  // ============================================================

  _setState: function (state) {
    var isConnected = state === 'connected';
    var isError = state === 'error';

    var titleText = isConnected
      ? '正在聆听...'
      : state === 'error'
        ? '连接失败'
        : state === 'connecting'
          ? '请稍后'
          : '连接中';

    var statusText = isConnected
      ? '通话中 · 点击挂断'
      : state === 'error'
        ? '连接失败'
        : state === 'connecting'
          ? '连接中…'
          : '已断开';

    this.setData({
      connectionState: state,
      isConnected: isConnected,
      isError: isError,
      titleText: titleText,
      statusText: statusText,
    });
  },

  _setError: function (message) {
    this.setData({
      connectionState: 'error',
      isConnected: false,
      isError: true,
      errorMessage: message,
      titleText: '连接失败',
      statusText: '',
    });
  },

  _clearBridgeTimeout: function () {
    if (this._bridgeReadyTimeout) {
      clearTimeout(this._bridgeReadyTimeout);
      this._bridgeReadyTimeout = null;
    }
  },
});
