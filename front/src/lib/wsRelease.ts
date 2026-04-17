/**
 * 释放 WebSocket，避免在 CONNECTING 时同步 close() 触发：
 * "WebSocket is closed before the connection is established."
 *
 * - CONNECTING：覆盖 onopen，握手成功后立刻 close（不再执行原逻辑如开麦）
 * - OPEN：直接 close
 */
export function releaseWebSocket(ws: WebSocket | null | undefined): void {
  if (!ws) return;
  try {
    const rs = ws.readyState;
    if (rs === WebSocket.CONNECTING) {
      ws.onopen = () => {
        try {
          ws.close(1000, 'release');
        } catch {
          // ignore
        }
      };
      return;
    }
    if (rs === WebSocket.OPEN) {
      ws.close(1000, 'release');
    }
  } catch {
    // ignore
  }
}
