/**
 * 小程序运行时配置（与 front 的 VITE_API_BASE_URL 对应）。
 * 只写协议 + 主机，不要带路径（如 /api/text/sse）。
 * SSE：apiUrl('/api/text/sse?...')；实时语音：wss://主机/ws/realtime
 *
 * 微信公众平台须配置：request 合法域名、socket 合法域名（含 fg.assistant.chainnv.com）
 */
module.exports = {
  apiBaseUrl: 'https://fg.assistant.chainnv.com',
};
