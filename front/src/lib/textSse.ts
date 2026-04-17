import { apiUrl } from './apiBase';

export type SseChatHandler = (content: string) => void;

/**
 * 调用后端 GET /api/text/sse，解析 SSE 流中的 chat 事件。
 */
export async function streamTextQuery(
  content: string,
  conversationId: string,
  onChat: SseChatHandler,
  signal?: AbortSignal
): Promise<void> {
  const params = new URLSearchParams({
    content,
    conversation_id: conversationId,
  });
  const url = apiUrl(`/api/text/sse?${params.toString()}`);
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`文本接口错误: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let eventName = '';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (eventName === 'chat' && dataLines.length) {
        try {
          const data = JSON.parse(dataLines.join('\n')) as { content?: string };
          if (data.content) onChat(data.content);
        } catch {
          // ignore
        }
      }
    }
  }
}
