export class PCMPlayer {
  audioCtx: AudioContext;
  nextTime: number;
  analyser: AnalyserNode;
  outputGain: GainNode;
  onVolume: (volume: number) => void;
  animationFrameId: number | null = null;
  activeSources = new Set<AudioBufferSourceNode>();
  unmuteTimer: number | null = null;
  private volumeFrame = 0;
  private lastVolumeEmit = 0;

  constructor(onVolume: (volume: number) => void) {
    this.audioCtx = new AudioContext({ sampleRate: 24000 });
    this.nextTime = this.audioCtx.currentTime;
    this.analyser = this.audioCtx.createAnalyser();
    this.outputGain = this.audioCtx.createGain();
    this.analyser.fftSize = 128;
    this.outputGain.gain.value = 1;
    this.analyser.connect(this.outputGain);
    this.outputGain.connect(this.audioCtx.destination);
    this.onVolume = onVolume;
    this.updateVolume();
  }

  updateVolume = () => {
    this.volumeFrame += 1;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    const average = sum / dataArray.length;
    // 约每 4 帧上报一次音量，减少 React 重绘；变化很小时跳过
    if (this.volumeFrame % 4 === 0) {
      if (Math.abs(average - this.lastVolumeEmit) > 2 || average < 1) {
        this.lastVolumeEmit = average;
        this.onVolume(average);
      }
    }
    this.animationFrameId = requestAnimationFrame(this.updateVolume);
  }

  play(base64Data: string) {
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    if (this.unmuteTimer) {
      window.clearTimeout(this.unmuteTimer);
      this.unmuteTimer = null;
    }
    this.outputGain.gain.cancelScheduledValues(this.audioCtx.currentTime);
    this.outputGain.gain.setValueAtTime(1, this.audioCtx.currentTime);

    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    const buffer = this.audioCtx.createBuffer(1, float32Array.length, 24000);
    buffer.getChannelData(0).set(float32Array);

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
    };

    if (this.nextTime < this.audioCtx.currentTime) {
      this.nextTime = this.audioCtx.currentTime;
    }
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
  }

  stop() {
    // 先硬静音，避免设备缓冲区里的尾音继续被听到。
    this.outputGain.gain.cancelScheduledValues(this.audioCtx.currentTime);
    this.outputGain.gain.setValueAtTime(0, this.audioCtx.currentTime);
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // source 可能已结束，忽略异常
      }
      source.disconnect();
    });
    this.activeSources.clear();
    this.nextTime = this.audioCtx.currentTime;
    this.unmuteTimer = window.setTimeout(() => {
      if (this.audioCtx.state === 'closed') return;
      this.outputGain.gain.cancelScheduledValues(this.audioCtx.currentTime);
      this.outputGain.gain.setValueAtTime(1, this.audioCtx.currentTime);
      this.unmuteTimer = null;
    }, 120);
  }

  isPlaying() {
    return this.nextTime > this.audioCtx.currentTime + 0.03;
  }
  
  close() {
    if (this.unmuteTimer) {
      window.clearTimeout(this.unmuteTimer);
      this.unmuteTimer = null;
    }
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    this.audioCtx.close();
  }
}

export class AudioRecorder {
  audioCtx: AudioContext;
  stream: MediaStream | null = null;
  processor: ScriptProcessorNode | null = null;
  onData: (base64: string) => void;
  onVoiceActivity?: () => void;
  // 降低拾音灵敏度：提高能量阈值并延长触发间隔，减少噪声误触发。
  vadThreshold = 0.03;
  vadCooldownMs = 700;
  lastVadAt = 0;
  speechFrames = 0;

  constructor(onData: (base64: string) => void, onVoiceActivity?: () => void) {
    this.onData = onData;
    this.onVoiceActivity = onVoiceActivity;
    this.audioCtx = new AudioContext({ sampleRate: 16000 });
  }

  /**
   * @param prefetched 若在用户点击等手势内已 getUserMedia，传入以避免异步阶段再请求被拒
   */
  async start(prefetched?: MediaStream | null) {
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
    this.stream =
      prefetched ??
      (await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      }));
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    
    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      let energy = 0;
      for (let i = 0; i < inputData.length; i++) {
        energy += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(energy / inputData.length);
      if (rms > this.vadThreshold) {
        this.speechFrames += 1;
      } else {
        this.speechFrames = 0;
      }
      const now = Date.now();
      if (this.speechFrames >= 3 && now - this.lastVadAt > this.vadCooldownMs) {
        this.lastVadAt = now;
        this.onVoiceActivity?.();
      }

      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
      }
      const buffer = new ArrayBuffer(pcm16.length * 2);
      const view = new DataView(buffer);
      for (let i = 0; i < pcm16.length; i++) {
        view.setInt16(i * 2, pcm16[i], true);
      }
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      this.onData(base64);
    };

    source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);
  }

  stop() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }
}
