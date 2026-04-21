/**
 * PCM 音频播放器 - 使用 wx.createWebAudioContext()
 * 替代 Web 端 PCMPlayer（front/src/lib/audio.ts）
 *
 * 接收 base64 编码的 PCM s16le 24kHz 音频，
 * 转换为 Float32Array 后通过 WebAudioContext 播放。
 * 支持无缝衔接、停止、isPlaying 检测。
 */

var { base64ToArrayBuffer } = require('./base64');

function createAudioContextSafe() {
  try {
    if (typeof wx.createWebAudioContext === 'function') {
      return wx.createWebAudioContext();
    }
  } catch (e) {}
  return null;
}

function PCMPlayer(onVolume, onFatal) {
  // wx.createWebAudioContext 在基础库 2.19.0+ 可用
  this._ctx = createAudioContextSafe();
  this._onVolume = onVolume || function () {};
  this._onFatal = onFatal || function () {};
  this._enabled = !!this._ctx;
  this._initError = this._enabled ? '' : '当前基础库不支持 WebAudioContext';
  if (!this._enabled) {
    this._onFatal({ errMsg: this._initError, stage: 'player_init' });
    return;
  }
  this._nextTime = this._ctx.currentTime;
  this._activeSources = [];
  this._outputGain = this._ctx.createGain();
  this._outputGain.gain.value = 1;
  this._outputGain.connect(this._ctx.destination);
  this._unmuteTimer = null;
}

/**
 * 播放 base64 编码的 PCM s16le 数据（24kHz）
 */
PCMPlayer.prototype.play = function (base64Data) {
  if (!this._enabled) return;
  var ctx = this._ctx;
  if (ctx.state === 'suspended') {
    ctx.resume();
  }

  // 取消之前的静音定时器
  if (this._unmuteTimer) {
    clearTimeout(this._unmuteTimer);
    this._unmuteTimer = null;
  }
  this._outputGain.gain.cancelScheduledValues(ctx.currentTime);
  this._outputGain.gain.setValueAtTime(1, ctx.currentTime);

  // base64 → ArrayBuffer → Int16Array → Float32Array
  var pcmBuffer = base64ToArrayBuffer(base64Data);
  if (!pcmBuffer || pcmBuffer.byteLength % 2 !== 0) {
    this._onFatal({
      errMsg: 'invalid pcm frame length',
      stage: 'player_decode',
    });
    return;
  }
  var int16Array = new Int16Array(pcmBuffer);
  var float32Array = new Float32Array(int16Array.length);
  for (var i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0;
  }

  // 创建 AudioBuffer 并播放
  var audioBuffer;
  var source;
  try {
    audioBuffer = ctx.createBuffer(1, float32Array.length, 24000);
    audioBuffer.getChannelData(0).set(float32Array);

    source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this._outputGain);
  } catch (err) {
    this._onFatal({
      errMsg: (err && err.message) || String(err),
      stage: 'player_decode',
    });
    return;
  }

  var self = this;
  this._activeSources.push(source);
  source.onended = function () {
    var idx = self._activeSources.indexOf(source);
    if (idx > -1) {
      self._activeSources.splice(idx, 1);
    }
  };

  // 无缝衔接：按 nextTime 调度
  if (this._nextTime < ctx.currentTime) {
    this._nextTime = ctx.currentTime;
  }
  source.start(this._nextTime);
  this._nextTime += audioBuffer.duration;
};

/**
 * 停止所有播放，短暂静音防止尾音
 */
PCMPlayer.prototype.stop = function () {
  if (!this._enabled) return;
  var ctx = this._ctx;

  // 硬静音
  this._outputGain.gain.cancelScheduledValues(ctx.currentTime);
  this._outputGain.gain.setValueAtTime(0, ctx.currentTime);

  // 停止所有活跃的 source
  for (var i = 0; i < this._activeSources.length; i++) {
    try {
      this._activeSources[i].stop();
    } catch (e) {
      // source 可能已结束
    }
    try {
      this._activeSources[i].disconnect();
    } catch (e) {
      // ignore
    }
  }
  this._activeSources = [];
  this._nextTime = ctx.currentTime;

  // 120ms 后恢复音量
  var self = this;
  this._unmuteTimer = setTimeout(function () {
    if (ctx.state === 'closed') return;
    self._outputGain.gain.cancelScheduledValues(ctx.currentTime);
    self._outputGain.gain.setValueAtTime(1, ctx.currentTime);
    self._unmuteTimer = null;
  }, 120);
};

/**
 * 是否正在播放
 */
PCMPlayer.prototype.isPlaying = function () {
  if (!this._enabled) return false;
  return this._nextTime > this._ctx.currentTime + 0.03;
};

/**
 * 关闭播放器，释放资源
 */
PCMPlayer.prototype.close = function () {
  if (!this._enabled) return;
  if (this._unmuteTimer) {
    clearTimeout(this._unmuteTimer);
    this._unmuteTimer = null;
  }
  this.stop();
  try {
    this._ctx.close();
  } catch (e) {
    // ignore
  }
};

/**
 * 获取内部 AudioContext（用于播放提示音等共享场景）
 */
PCMPlayer.prototype.getAudioContext = function () {
  return this._ctx;
};

PCMPlayer.prototype.isAvailable = function () {
  return this._enabled;
};

PCMPlayer.prototype.getInitError = function () {
  return this._initError;
};

module.exports = { PCMPlayer };
