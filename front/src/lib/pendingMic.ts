/**
 * 从「电话」等用户手势里预先拿到的麦克风 MediaStream，
 * 供实时页在 WebSocket onopen 后使用（避免异步后再 getUserMedia 被浏览器拦截）。
 */
let pending: MediaStream | null = null;

export function setPendingMicStream(stream: MediaStream | null) {
  if (pending && pending !== stream) {
    pending.getTracks().forEach((t) => t.stop());
  }
  pending = stream;
}

export function takePendingMicStream(): MediaStream | null {
  const s = pending;
  pending = null;
  return s;
}

export function clearPendingMicStream() {
  if (pending) {
    pending.getTracks().forEach((t) => t.stop());
    pending = null;
  }
}
