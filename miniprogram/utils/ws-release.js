/**
 * 安全释放 WebSocket，避免在 CONNECTING 时同步 close() 出错
 * 移植自 front/src/lib/wsRelease.ts
 */

function releaseWebSocket(ws) {
  if (!ws) return;
  try {
    var rs = ws.readyState;
    if (rs === 0) {
      // 仍在连接中：覆盖 onopen，握手成功后立刻关闭
      ws.onopen = function () {
        try {
          ws.close(1000, 'release');
        } catch (e) {
          // ignore
        }
      };
      return;
    }
    if (rs === 1) {
      ws.close(1000, 'release');
    }
  } catch (e) {
    // ignore
  }
}

module.exports = { releaseWebSocket };
