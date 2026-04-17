/**
 * UI 提示音：必须用已在通话里跑起来的 AudioContext（如 PCMPlayer / AudioRecorder），
 * 新建 AudioContext 容易被浏览器静音策略拦截，导致「不响」。
 */

function scheduleToneBurst(
  ctx: AudioContext,
  config: { freqs: number[]; spacing: number; gain: number; dur: number }
) {
  const run = () => {
    if (ctx.state === 'closed') return;
    const now = ctx.currentTime;
    config.freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = now + i * config.spacing;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(config.gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + config.dur);
      osc.start(t0);
      osc.stop(t0 + config.dur + 0.02);
    });
  };

  if (ctx.state === 'suspended') {
    void ctx.resume().then(run).catch(() => run());
  } else {
    run();
  }
}

/** 连接成功：两声偏高短音（滴、滴） */
export function playConnectChime(ctx: AudioContext): void {
  scheduleToneBurst(ctx, { freqs: [784, 988], spacing: 0.07, gain: 0.12, dur: 0.1 });
}

/** 挂断：两声偏低短音（滴、滴） */
export function playHangupChime(ctx: AudioContext): void {
  scheduleToneBurst(ctx, { freqs: [587.33, 440], spacing: 0.09, gain: 0.16, dur: 0.13 });
}

/** 从播放器或录音机任选一个可用的 AudioContext（优先播放侧 24kHz） */
export function pickAudioContextForUi(
  player: { audioCtx: AudioContext } | null,
  recorder: { audioCtx: AudioContext | null } | null
): AudioContext | null {
  if (player?.audioCtx && player.audioCtx.state !== 'closed') {
    return player.audioCtx;
  }
  if (recorder?.audioCtx && recorder.audioCtx.state !== 'closed') {
    return recorder.audioCtx;
  }
  return null;
}
