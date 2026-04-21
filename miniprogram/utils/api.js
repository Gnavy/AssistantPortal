/**
 * API 基础配置，移植自 front/src/lib/apiBase.ts
 * 基地址优先读 app.globalData.apiBaseUrl（便于运行时覆盖），否则用 ../config.js
 */
var fileConfig = {};
try {
  fileConfig = require('../config.js');
} catch (e) {
  fileConfig = {};
}

function getApiBaseUrl() {
  try {
    var app = getApp && getApp();
    if (app && app.globalData && app.globalData.apiBaseUrl) {
      return String(app.globalData.apiBaseUrl).trim().replace(/\/$/, '');
    }
  } catch (err) {
    // getApp 未就绪时忽略
  }
  var fromFile = fileConfig.apiBaseUrl;
  if (fromFile && String(fromFile).trim()) {
    return String(fromFile).trim().replace(/\/$/, '');
  }
  return 'https://fg.assistant.chainnv.com';
}

function apiUrl(path) {
  var base = getApiBaseUrl();
  var p = path.startsWith('/') ? path : '/' + path;
  return base ? base + p : p;
}

/**
 * 实时语音 WebSocket 完整 URL（http(s) 转 ws(s)）
 */
function resolveRealtimeWsUrl(conversationId) {
  var query = conversationId
    ? '?conversation_id=' + encodeURIComponent(conversationId)
    : '';
  var baseUrl = getApiBaseUrl();
  if (baseUrl) {
    var trimmed = baseUrl.replace(/\/$/, '');
    if (/^wss?:\/\//i.test(trimmed)) {
      return trimmed + '/ws/realtime' + query;
    }
    var wsBase = trimmed
      .replace(/^https:\/\//i, 'wss://')
      .replace(/^http:\/\//i, 'ws://');
    return wsBase + '/ws/realtime' + query;
  }
  return 'wss://fg.assistant.chainnv.com/ws/realtime' + query;
}

module.exports = {
  getApiBaseUrl,
  apiUrl,
  resolveRealtimeWsUrl,
};
