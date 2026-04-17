export function getApiBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? '';
}

export function apiUrl(path: string): string {
  const base = getApiBaseUrl().replace(/\/$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}

/**
 * 实时语音 WebSocket 完整 URL。VITE_API_BASE_URL 为 http(s) 时必须转成 ws(s)，
 * 否则 new WebSocket 使用非法 scheme，会连不上（控制台 / Network 里常与 101 握手混淆）。
 */
export function resolveRealtimeWsUrl(conversationId?: string): string {
  const query = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : '';
  const baseUrl = getApiBaseUrl();
  if (baseUrl) {
    const trimmed = baseUrl.replace(/\/$/, '');
    if (/^wss?:\/\//i.test(trimmed)) {
      return `${trimmed}/ws/realtime${query}`;
    }
    const wsBase = trimmed
      .replace(/^https:\/\//i, 'wss://')
      .replace(/^http:\/\//i, 'ws://');
    return `${wsBase}/ws/realtime${query}`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/realtime${query}`;
}
