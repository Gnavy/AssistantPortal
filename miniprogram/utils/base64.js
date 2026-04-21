/**
 * Base64 与 ArrayBuffer 互转工具
 * 替代 Web 端的 btoa() / atob()
 */

function arrayBufferToBase64(buffer) {
  return wx.arrayBufferToBase64(buffer);
}

function base64ToArrayBuffer(base64) {
  return wx.base64ToArrayBuffer(base64);
}

function base64ToUint8Array(base64) {
  const buffer = wx.base64ToArrayBuffer(base64);
  return new Uint8Array(buffer);
}

function uint8ArrayToBase64(uint8Array) {
  return wx.arrayBufferToBase64(uint8Array.buffer);
}

module.exports = {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  base64ToUint8Array,
  uint8ArrayToBase64,
};
