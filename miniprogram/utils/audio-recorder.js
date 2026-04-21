/**
 * 音频录制器 - 使用 wx.getRecorderManager + onFrameRecorded
 * 替代 Web 端 AudioRecorder（front/src/lib/audio.ts）
 *
 * PCM s16le 16kHz 单声道，帧回调输出 base64 编码的 PCM 数据
 * 内置 VAD（语音活动检测）
 */

var { arrayBufferToBase64 } = require('./base64');

var VAD_DEFAULTS = {
  threshold: 0.045,
  cooldownMs: 1300,
  minActiveFrames: 7,
  minVoiceMs: 220,
  noiseWindowFrames: 50,
  noiseFloorRatio: 1.8,
};

function AudioRecorder(options) {
  options = options || {};
  this._manager = wx.getRecorderManager();
  this._onData = options.onData || function () {};
  this._onVoiceActivity = options.onVoiceActivity || function () {};
  this._onStart = options.onStart || function () {};
  this._onStop = options.onStop || function () {};
  this._onFatal = options.onFatal || function () {};
  this._isRecording = false;
  this._isStarting = false;
  this._startResolve = null;
  this._startReject = null;

  // VAD 参数（抗干扰增强）
  var vadOptions = options.vad || {};
  this._vadThreshold = Number(vadOptions.threshold || VAD_DEFAULTS.threshold);
  this._vadCooldownMs = Number(vadOptions.cooldownMs || VAD_DEFAULTS.cooldownMs);
  this._vadMinActiveFrames = Number(
    vadOptions.minActiveFrames || VAD_DEFAULTS.minActiveFrames
  );
  this._vadMinVoiceMs = Number(vadOptions.minVoiceMs || VAD_DEFAULTS.minVoiceMs);
  this._noiseWindowFrames = Number(
    vadOptions.noiseWindowFrames || VAD_DEFAULTS.noiseWindowFrames
  );
  this._noiseFloorRatio = Number(
    vadOptions.noiseFloorRatio || VAD_DEFAULTS.noiseFloorRatio
  );
  this._debug = !!options.debug;
  this._lastVadAt = 0;
  this._speechFrames = 0;
  this._speechMs = 0;
  this._noiseHistory = [];

  var self = this;

  // 帧回调：实时获取 PCM 数据
  this._manager.onFrameRecorded(function (res) {
    if (!self._isRecording) return;

    var frameBuffer = res.frameBuffer; // ArrayBuffer (PCM s16le)

    // VAD：计算 RMS 能量
    var int16 = new Int16Array(frameBuffer);
    var energy = 0;
    for (var i = 0; i < int16.length; i++) {
      var floatVal = int16[i] / 32768.0;
      energy += floatVal * floatVal;
    }
    var rms = Math.sqrt(energy / int16.length);

    var frameDurationMs = int16.length > 0 ? (int16.length / 16000) * 1000 : 0;
    self._noiseHistory.push(rms);
    if (self._noiseHistory.length > self._noiseWindowFrames) {
      self._noiseHistory.shift();
    }

    var noiseFloor = 0;
    if (self._noiseHistory.length > 0) {
      var sum = 0;
      for (var n = 0; n < self._noiseHistory.length; n++) {
        sum += self._noiseHistory[n];
      }
      noiseFloor = sum / self._noiseHistory.length;
    }
    var dynamicThreshold = Math.max(
      self._vadThreshold,
      noiseFloor * self._noiseFloorRatio
    );
    var isSpeechFrame = rms > dynamicThreshold;

    if (isSpeechFrame) {
      self._speechFrames += 1;
      self._speechMs += frameDurationMs;
    } else {
      self._speechFrames = 0;
      self._speechMs = 0;
    }

    var now = Date.now();
    var passFrames = self._speechFrames >= self._vadMinActiveFrames;
    var passVoiceMs = self._speechMs >= self._vadMinVoiceMs;
    if (
      passFrames &&
      passVoiceMs &&
      now - self._lastVadAt > self._vadCooldownMs
    ) {
      self._lastVadAt = now;
      if (self._onVoiceActivity) {
        self._onVoiceActivity({
          rms: rms,
          dynamicThreshold: dynamicThreshold,
          noiseFloor: noiseFloor,
          speechFrames: self._speechFrames,
          speechMs: self._speechMs,
        });
      }
      if (self._debug) {
        console.info('[vad_trigger]', {
          rms: Number(rms.toFixed(4)),
          threshold: Number(dynamicThreshold.toFixed(4)),
          noiseFloor: Number(noiseFloor.toFixed(4)),
          frames: self._speechFrames,
          speechMs: Number(self._speechMs.toFixed(1)),
        });
      }
    } else if (self._debug && isSpeechFrame && !passVoiceMs) {
      console.info('[vad_reject_reason]', {
        reason: 'speech_too_short',
        speechMs: Number(self._speechMs.toFixed(1)),
        minVoiceMs: self._vadMinVoiceMs,
      });
    } else if (self._debug && isSpeechFrame && !passFrames) {
      console.info('[vad_reject_reason]', {
        reason: 'not_enough_frames',
        speechFrames: self._speechFrames,
        minActiveFrames: self._vadMinActiveFrames,
      });
    }

    // 转为 base64 输出（与 Web 版 btoa 方式对齐）
    var base64 = arrayBufferToBase64(frameBuffer);
    self._onData(base64);
  });

  this._manager.onStart(function () {
    self._isStarting = false;
    self._isRecording = true;
    if (self._startResolve) {
      self._startResolve();
      self._startResolve = null;
      self._startReject = null;
    }
    self._onStart();
  });

  this._manager.onStop(function () {
    self._isStarting = false;
    self._isRecording = false;
    self._onStop();
  });

  // 错误处理
  this._manager.onError(function (err) {
    var msg = (err && err.errMsg) || 'RecorderManager error';
    console.error('RecorderManager error:', msg);
    var isNotStartError =
      msg.indexOf('operateRecorder:fail recorder not start') !== -1;

    // stop() 时若 recorder 尚未 start，微信会抛该错误；属于可忽略噪声
    if (isNotStartError && !self._isStarting && !self._isRecording) {
      return;
    }

    if (self._isStarting && self._startReject) {
      self._startReject(new Error(msg));
      self._startResolve = null;
      self._startReject = null;
    }
    self._isStarting = false;
    self._isRecording = false;
    self._onFatal(err || { errMsg: msg });
  });
}

/**
 * 开始录音
 */
AudioRecorder.prototype.start = function () {
  var self = this;
  if (this._isRecording) {
    return Promise.resolve();
  }
  if (this._isStarting) {
    return new Promise(function (resolve, reject) {
      var wait = setInterval(function () {
        if (self._isRecording) {
          clearInterval(wait);
          resolve();
          return;
        }
        if (!self._isStarting) {
          clearInterval(wait);
          reject(new Error('Recorder start interrupted'));
        }
      }, 30);
    });
  }
  this._speechFrames = 0;
  this._speechMs = 0;
  this._lastVadAt = 0;
  this._isStarting = true;

  return new Promise(function (resolve, reject) {
    self._startResolve = resolve;
    self._startReject = reject;
    var timeout = setTimeout(function () {
      if (!self._isStarting) return;
      self._isStarting = false;
      self._startResolve = null;
      self._startReject = null;
      reject(new Error('Recorder start timeout'));
    }, 2500);

    var doneOnce = false;
    function wrapResolve() {
      if (doneOnce) return;
      doneOnce = true;
      clearTimeout(timeout);
      resolve();
    }
    function wrapReject(err) {
      if (doneOnce) return;
      doneOnce = true;
      clearTimeout(timeout);
      reject(err);
    }
    self._startResolve = wrapResolve;
    self._startReject = wrapReject;

    // frameSize 使用数值（KB），避免真机对字符串参数兼容不一致
    try {
      self._manager.start({
        format: 'PCM',
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        frameSize: 16,
      });
    } catch (err) {
      self._isStarting = false;
      self._startResolve = null;
      self._startReject = null;
      wrapReject(err instanceof Error ? err : new Error(String(err)));
    }
  });
};

/**
 * 停止录音
 */
AudioRecorder.prototype.stop = function () {
  // 未启动时不调用底层 stop，避免触发 recorder not start
  if (!this._isStarting && !this._isRecording) {
    return;
  }
  this._isStarting = false;
  this._isRecording = false;
  this._startResolve = null;
  this._startReject = null;
  try {
    this._manager.stop();
  } catch (e) {
    // ignore
  }
};

module.exports = { AudioRecorder };
