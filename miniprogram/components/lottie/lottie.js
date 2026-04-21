/**
 * Lottie 动画组件（官方库用法）
 * 参考: https://github.com/wechat-miniprogram/lottie-miniprogram
 *
 * 关键点:
 * - 必须先 setup(canvas)
 * - loadAnimation 仅支持 animationData 或 http(s) path
 */

var loadAnimation;
var setupLottie;
try {
  var pkg = require('lottie-miniprogram');
  loadAnimation = pkg.loadAnimation;
  setupLottie = pkg.setup;
} catch (e) {
  console.warn('lottie-miniprogram 未就绪，请先在开发者工具中构建 npm', e);
}

var ANIMATION_BY_PATH = {};
function registerAnim(keys, data) {
  if (!data) return;
  for (var i = 0; i < keys.length; i++) {
    ANIMATION_BY_PATH[keys[i]] = data;
  }
}

try {
  var hiData = require('./data/hi.js');
  registerAnim(['/assets/hi.json', 'assets/hi.json'], hiData);
} catch (e) {
  console.warn('lottie 缺少 ./data/hi.js', e);
}

try {
  // 语音页按状态切换 intro/loop
  var avatarData = require('./data/avatar.safe.js');
  var avatarIntroData = require('./data/avatar-intro.safe.js');
  var avatarLoopData = require('./data/avatar-loop.safe.js');
  registerAnim(['/assets/avatar.json', 'assets/avatar.json'], avatarData);
  registerAnim(['/assets/avatar-intro.json', 'assets/avatar-intro.json'], avatarIntroData);
  registerAnim(['/assets/avatar-loop.json', 'assets/avatar-loop.json'], avatarLoopData);
} catch (e) {
  console.warn('lottie 缺少 avatar safe 数据文件', e);
}

function normalizeLottiePath(p) {
  if (!p) return '';
  p = String(p).trim();
  if (!p) return '';
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}


function isAvatarPath(pathKey, rawPath) {
  var p = String(pathKey || rawPath || '');
  return p.indexOf('avatar') !== -1;
}

function ensureOpacityZero(layer) {
  var ks = layer.ks || (layer.ks = {});
  var o = ks.o;
  if (!o || typeof o !== 'object') {
    ks.o = { a: 0, k: 0, ix: 11 };
    return;
  }
  o.a = 0;
  o.k = 0;
}

function sanitizeAvatarMaskLayers(animationData) {
  if (!animationData || typeof animationData !== 'object') return animationData;
  var data;
  try {
    data = JSON.parse(JSON.stringify(animationData));
  } catch (e) {
    return animationData;
  }

  function walkLayers(layers) {
    if (!Array.isArray(layers)) return;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (!layer || typeof layer !== 'object') continue;
      if (layer.nm === 'Shape Layer 1') {
        layer.hd = true;
        ensureOpacityZero(layer);
      }
    }
  }

  function shiftLayerY(layer, deltaY) {
    if (!layer || typeof layer !== 'object') return;
    var ks = layer.ks || {};
    var p = ks.p;
    if (!p) return;
    if (p.a === 0) {
      if (!Array.isArray(p.k) || p.k.length < 2) return;
      p.k[1] = Number(p.k[1]) + deltaY;
      return;
    }
    if (p.a === 1 && Array.isArray(p.k)) {
      for (var i = 0; i < p.k.length; i++) {
        var key = p.k[i];
        if (!key || !Array.isArray(key.s) || key.s.length < 2) continue;
        key.s[1] = Number(key.s[1]) + deltaY;
        if (Array.isArray(key.e) && key.e.length >= 2) {
          key.e[1] = Number(key.e[1]) + deltaY;
        }
      }
    }
  }

  function shiftAvatarSubjectLayers(layers) {
    if (!Array.isArray(layers)) return;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (!layer || typeof layer !== 'object') continue;
      // 只移动身体层，保持头部不动，避免脖子被覆盖
      if (layer.nm === 'bdn') {
        shiftLayerY(layer, 24);
      }
    }
  }

  walkLayers(data.layers);
  if (Array.isArray(data.assets)) {
    for (var j = 0; j < data.assets.length; j++) {
      var a = data.assets[j];
      if (a && Array.isArray(a.layers)) {
        walkLayers(a.layers);
        shiftAvatarSubjectLayers(a.layers);
      }
    }
  }
  return data;
}

function installAvatarCircleClip(ctx, props, pathKey, rawPath) {
  if (!isAvatarPath(pathKey, rawPath)) return function () {};

  var originalClearRect = ctx.clearRect ? ctx.clearRect.bind(ctx) : null;
  var clipped = false;

  function applyClip() {
    try {
      if (clipped) {
        ctx.restore();
        clipped = false;
      }

      var w = Number(props.width || 260);
      var h = Number(props.height || 260);
      var cx = w * 0.5;
      var cy = h * 0.47;
      var r = Math.min(w, h) * 0.30;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      clipped = true;
    } catch (e) {
      // ignore
    }
  }

  if (originalClearRect) {
    ctx.clearRect = function (x, y, w, h) {
      originalClearRect(x, y, w, h);
      applyClip();
    };
  }

  applyClip();

  return function removeClipHook() {
    try {
      if (originalClearRect) {
        ctx.clearRect = originalClearRect;
      }
      if (clipped) {
        ctx.restore();
        clipped = false;
      }
    } catch (e) {
      // ignore
    }
  };
}

Component({
  properties: {
    path: {
      type: String,
      value: '',
    },
    width: {
      type: Number,
      value: 200,
    },
    height: {
      type: Number,
      value: 200,
    },
    autoplay: {
      type: Boolean,
      value: false,
    },
    loop: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    _ready: false,
  },

  observers: {
    path: function (next) {
      if (!next) return;
      this._scheduleInit();
    },
    autoplay: function () {
      this._scheduleInit();
    },
    loop: function () {
      this._scheduleInit();
    },
  },

  lifetimes: {
    attached: function () {
      if (!loadAnimation || !setupLottie) return;
      this._scheduleInit();
    },
    detached: function () {
      this._destroyAni();
    },
  },

  methods: {
    _destroyAni: function () {
      if (this._removeAvatarClip) {
        try {
          this._removeAvatarClip();
        } catch (e) {}
        this._removeAvatarClip = null;
      }
      if (this._ani) {
        try {
          this._ani.destroy();
        } catch (e) {}
        this._ani = null;
      }
    },

    _scheduleInit: function () {
      var self = this;
      if (!loadAnimation || !setupLottie) return;
      if (self._initTimer) {
        clearTimeout(self._initTimer);
        self._initTimer = null;
      }
      self._initTimer = setTimeout(function () {
        self._initTimer = null;
        self._init();
      }, 30);
    },

    _init: function () {
      var self = this;
      var props = this.properties;
      if (!loadAnimation || !setupLottie || !props.path) return;

      var pathKey = normalizeLottiePath(props.path);

      this.createSelectorQuery()
        .in(this)
        .select('#lottie-canvas')
        .fields({ node: true, size: true })
        .exec(function (res) {
          if (!res || !res[0] || !res[0].node) return;

          self._destroyAni();

          var canvas = res[0].node;
          var ctx = canvas.getContext('2d');

          var dpr = 2;
          try {
            dpr = wx.getWindowInfo
              ? wx.getWindowInfo().pixelRatio
              : wx.getSystemInfoSync().pixelRatio;
          } catch (e) {
            dpr = 2;
          }
          canvas.width = props.width * dpr;
          canvas.height = props.height * dpr;
          ctx.scale(dpr, dpr);

          // 官方库要求: setup 在 loadAnimation 前
          setupLottie(canvas);

          // avatar: 强制单圆 clip，仅显示圆内内容
          self._removeAvatarClip = installAvatarCircleClip(ctx, props, pathKey, props.path);

          var opts = {
            loop: props.loop,
            autoplay: props.autoplay,
            rendererSettings: { context: ctx },
          };

          var animationData = ANIMATION_BY_PATH[pathKey] || ANIMATION_BY_PATH[props.path];
          if (animationData && isAvatarPath(pathKey, props.path)) {
            animationData = sanitizeAvatarMaskLayers(animationData);
          }
          if (animationData) {
            opts.animationData = animationData;
          } else if (/^https?:\/\//.test(props.path)) {
            opts.path = props.path;
          } else {
            console.warn('lottie: path 未命中动画映射且非 https，path=', props.path);
            return;
          }

          var ani;
          try {
            ani = loadAnimation(opts);
          } catch (err) {
            console.error('lottie loadAnimation 失败', err);
            return;
          }

          self._ani = ani;

          var readyOnce = false;
          function emitReady() {
            if (readyOnce) return;
            readyOnce = true;
            self.setData({ _ready: true });
            self.triggerEvent('ready');
          }

          ani.addEventListener('DOMLoaded', emitReady);
          setTimeout(function () {
            emitReady();
          }, 300);

          ani.addEventListener('complete', function () {
            self.triggerEvent('complete');
          });
        });
    },

    playSegment: function (start, end, loop) {
      if (!this._ani) return;
      this._ani.loop = !!loop;
      this._ani.playSegments([start, end], true);
      this._ani.play();
    },

    stop: function () {
      if (!this._ani) return;
      this._ani.stop();
    },

    setFrame: function (frame) {
      if (!this._ani) return;
      this._ani.goToAndStop(frame, true);
    },

    play: function () {
      if (!this._ani) return;
      this._ani.play();
    },

    setLoop: function (loop) {
      if (!this._ani) return;
      this._ani.loop = !!loop;
    },

    destroy: function () {
      this._destroyAni();
    },
  },
});
