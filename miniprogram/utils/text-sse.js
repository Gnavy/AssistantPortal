/**
 * SSE 文本流式查询 - 使用 wx.request enableChunked
 * 移植自 front/src/lib/textSse.ts
 */
var { apiUrl } = require('./api');

function concatUint8(a, b) {
  if (!a || a.length === 0) return b || new Uint8Array(0);
  if (!b || b.length === 0) return a;
  var out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function uint8ToBinary(bytes) {
  var CHUNK = 0x8000;
  var parts = [];
  for (var i = 0; i < bytes.length; i += CHUNK) {
    var sub = bytes.subarray(i, i + CHUNK);
    parts.push(String.fromCharCode.apply(null, sub));
  }
  return parts.join('');
}

function createUtf8ChunkDecoder() {
  var pending = new Uint8Array(0);

  function decodeChunk(arrayBuffer) {
    if (typeof arrayBuffer === 'string') return arrayBuffer;
    if (!(arrayBuffer instanceof ArrayBuffer)) return '';

    var input = concatUint8(pending, new Uint8Array(arrayBuffer));
    if (!input.length) {
      pending = new Uint8Array(0);
      return '';
    }

    var keep = 0;
    var i = input.length - 1;
    while (i >= 0 && keep < 3 && (input[i] & 0xc0) === 0x80) {
      keep += 1;
      i -= 1;
    }
    if (i < 0) {
      pending = input;
      return '';
    }

    var lead = input[i];
    var expect = 1;
    if ((lead & 0x80) === 0x00) expect = 1;
    else if ((lead & 0xe0) === 0xc0) expect = 2;
    else if ((lead & 0xf0) === 0xe0) expect = 3;
    else if ((lead & 0xf8) === 0xf0) expect = 4;
    else expect = 1;

    if (keep + 1 < expect) {
      pending = input.slice(i);
      input = input.slice(0, i);
    } else {
      pending = new Uint8Array(0);
    }

    if (!input.length) return '';
    try {
      return decodeURIComponent(escape(uint8ToBinary(input)));
    } catch (e) {
      // 数据异常时按 latin1 兜底，避免中断整个流式会话
      return uint8ToBinary(input);
    }
  }

  return {
    decodeChunk: decodeChunk,
  };
}

/**
 * @param {string} content
 * @param {string} conversationId
 * @param {function(string): void} onChat
 * @param {{ onComplete?: function(detail: { ok: boolean, cancelled?: boolean, statusCode?: number, errMsg?: string }): void }} [options]
 * @returns {function(): void} abortFn
 */
function streamTextQuery(content, conversationId, onChat, options) {
  options = options || {};
  var onComplete = options.onComplete;

  var params =
    'content=' +
    encodeURIComponent(content) +
    '&conversation_id=' +
    encodeURIComponent(conversationId);
  var url = apiUrl('/api/text/sse?' + params);

  var buffer = '';
  var aborted = false;
  var requestTask;
  var utf8Decoder = createUtf8ChunkDecoder();

  function parseBuffer() {
    var idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      var block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      var eventName = '';
      var dataLines = [];
      var lines = block.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('event:') === 0) {
          eventName = line.slice(6).trim();
        } else if (line.indexOf('data:') === 0) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (eventName === 'chat' && dataLines.length > 0) {
        try {
          var data = JSON.parse(dataLines.join('\n'));
          if (data.content) {
            onChat(data.content);
          }
        } catch (e) {
          // ignore JSON parse error
        }
      }
    }
  }

  function appendChunk(arrayBuffer) {
    var chunk = utf8Decoder.decodeChunk(arrayBuffer);
    if (!chunk) return;
    buffer += chunk;
    parseBuffer();
  }

  function fireComplete(detail) {
    if (typeof onComplete === 'function') {
      onComplete(detail);
    }
  }

  requestTask = wx.request({
    url: url,
    method: 'GET',
    enableChunked: true,
    responseType: 'text',
    success: function (res) {
      if (aborted) {
        fireComplete({ ok: false, cancelled: true });
        return;
      }
      var status = res.statusCode || 0;
      if (status < 200 || status >= 300) {
        fireComplete({
          ok: false,
          cancelled: false,
          statusCode: status,
          errMsg: '文本接口错误: ' + status,
        });
        return;
      }
      fireComplete({ ok: true, cancelled: false });
    },
    fail: function (err) {
      if (aborted) {
        fireComplete({ ok: false, cancelled: true });
        return;
      }
      fireComplete({
        ok: false,
        cancelled: false,
        errMsg: (err && err.errMsg) || '网络请求失败',
      });
    },
  });

  requestTask.onChunkReceived(function (res) {
    if (aborted) return;
    appendChunk(res.data);
  });

  return function abort() {
    aborted = true;
    if (requestTask) {
      requestTask.abort();
    }
  };
}

module.exports = { streamTextQuery };
