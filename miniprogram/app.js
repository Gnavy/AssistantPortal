var { generateUUID } = require('./utils/uuid');
var runtimeConfig = {};
try {
  runtimeConfig = require('./config.js');
} catch (e) {
  runtimeConfig = {};
}

App({
  globalData: {
    conversationId: '',
    messages: [],
    pendingVoiceMessages: [],
    /** 可选：与 config.js 同步，便于运行时覆盖；空则 utils/api 回退到 config 文件 */
    apiBaseUrl: (runtimeConfig && runtimeConfig.apiBaseUrl) || '',
  },

  onLaunch: function () {
    this.globalData.conversationId = 'c-' + generateUUID();
  },

  addMessage: function (msg) {
    this.globalData.messages = this.globalData.messages.concat([msg]);
  },

  addMessages: function (msgs) {
    this.globalData.messages = this.globalData.messages.concat(msgs);
  },

  updateMessage: function (id, updates) {
    this.globalData.messages = this.globalData.messages.map(function (m) {
      return m.id === id ? Object.assign({}, m, updates) : m;
    });
  },

  addPendingVoiceMessage: function (msg) {
    this.globalData.pendingVoiceMessages =
      this.globalData.pendingVoiceMessages.concat([msg]);
  },

  clearPendingVoiceMessages: function () {
    this.globalData.pendingVoiceMessages = [];
  },

  mergeVoiceMessages: function () {
    if (this.globalData.pendingVoiceMessages.length > 0) {
      this.globalData.messages = this.globalData.messages.concat(
        this.globalData.pendingVoiceMessages
      );
      this.globalData.pendingVoiceMessages = [];
    }
  },
});
