/**
 * 生成提示音 WAV 文件的 Node.js 脚本
 * 运行: node miniprogram/generate-sounds.js
 */
var fs = require('fs');
var path = require('path');

function generateToneWav(freqs, spacing, gain, duration, sampleRate) {
  sampleRate = sampleRate || 44100;
  var totalDuration = (freqs.length - 1) * spacing + duration + 0.05;
  var numSamples = Math.ceil(totalDuration * sampleRate);
  var numChannels = 1;
  var bitsPerSample = 16;
  var dataSize = numSamples * numChannels * (bitsPerSample / 8);
  var buffer = Buffer.alloc(44 + dataSize);

  // WAV header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (var i = 0; i < numSamples; i++) {
    var t = i / sampleRate;
    var sample = 0;

    for (var f = 0; f < freqs.length; f++) {
      var t0 = f * spacing;
      var tEnd = t0 + duration;
      if (t >= t0 && t <= tEnd) {
        var localT = t - t0;
        // Envelope: quick attack, sustain, exponential decay
        var env = 0;
        if (localT < 0.012) {
          env = (localT / 0.012) * gain;
        } else if (localT < duration - 0.01) {
          env = gain;
        } else {
          env = gain * Math.exp(-10 * (localT - (duration - 0.01)));
        }
        sample += Math.sin(2 * Math.PI * freqs[f] * localT) * env;
      }
    }

    // Clamp
    sample = Math.max(-1, Math.min(1, sample));
    var intSample = Math.round(sample * 32767);
    buffer.writeInt16LE(intSample, 44 + i * 2);
  }

  return buffer;
}

var assetsDir = path.join(__dirname, 'assets');

// Connect chime: 784Hz + 988Hz
var connectWav = generateToneWav([784, 988], 0.07, 0.12, 0.1);
fs.writeFileSync(path.join(assetsDir, 'connect.wav'), connectWav);
console.log('Generated connect.wav');

// Hangup chime: 587Hz + 440Hz
var hangupWav = generateToneWav([587.33, 440], 0.09, 0.16, 0.13);
fs.writeFileSync(path.join(assetsDir, 'hangup.wav'), hangupWav);
console.log('Generated hangup.wav');

console.log('Done!');
