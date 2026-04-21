/**
 * WebSocket 封装 - 将 wx.connectSocket 封装为类浏览器 WebSocket 接口
 * 移植自 front/src/hooks/useLiveAPI.ts 中对 WebSocket 的使用
 */

// readyState 常量
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

class WxWebSocket {
  constructor(url) {
    this._url = url;
    this._task = null;
    this.readyState = CONNECTING;

    // 事件回调（外部赋值）
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }

  /**
   * 建立连接（构造后需显式调用）
   */
  connect() {
    const self = this;
    this.readyState = CONNECTING;

    this._task = wx.connectSocket({
      url: this._url,
      header: {
        'content-type': 'application/octet-stream',
      },
      success: function () {
        // 连接请求已发出，但尚未建立
      },
      fail: function (err) {
        self.readyState = CLOSING;
        if (self.onerror) {
          self.onerror({
            errMsg: err.errMsg || 'connectSocket failed',
            errCode: err.errCode,
            stage: 'connect',
          });
        }
      },
    });

    this._task.onOpen(function () {
      self.readyState = OPEN;
      if (self.onopen) {
        self.onopen();
      }
    });

    this._task.onMessage(function (res) {
      if (self.onmessage) {
        // res.data 可以是 string 或 ArrayBuffer，与浏览器一致
        self.onmessage({ data: res.data });
      }
    });

    this._task.onClose(function (res) {
      self.readyState = CLOSED;
      if (self.onclose) {
        self.onclose({
          code: res.code || 1000,
          reason: res.reason || '',
          errMsg: res.errMsg || '',
        });
      }
    });

    this._task.onError(function (err) {
      if (self.readyState !== CLOSED) {
        self.readyState = CLOSING;
      }
      if (self.onerror) {
        self.onerror({
          errMsg: err.errMsg || 'WebSocket error',
          errCode: err.errCode,
          stage: 'runtime',
        });
      }
    });
  }

  /**
   * 发送数据（string 或 ArrayBuffer）
   */
  send(data) {
    if (!this._task) return;
    if (this.readyState !== OPEN) return;
    const self = this;
    this._task.send({
      data: data,
      fail: function (err) {
        if (self.onerror) {
          self.onerror({
            errMsg: (err && err.errMsg) || 'WebSocket send failed',
            errCode: err && err.errCode,
            stage: 'send',
          });
        }
      },
    });
  }

  /**
   * 关闭连接
   */
  close(code, reason) {
    if (!this._task) return;
    this.readyState = CLOSING;
    this._task.close({
      code: code || 1000,
      reason: reason || '',
    });
  }
}

WxWebSocket.CONNECTING = CONNECTING;
WxWebSocket.OPEN = OPEN;
WxWebSocket.CLOSING = CLOSING;
WxWebSocket.CLOSED = CLOSED;

module.exports = { WxWebSocket };
