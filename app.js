const $ = (id) => document.getElementById(id);

const ui = {
  micStatus: $('micStatus'),
  noteName: $('noteName'),
  frequency: $('frequency'),
  pitchMessage: $('pitchMessage'),
  centsReadout: $('centsReadout'),
  tunerCanvas: $('tunerCanvas'),
  waveCanvas: $('waveCanvas'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  calibrateBtn: $('calibrateBtn'),
  recordBtn: $('recordBtn'),
  downloadBtn: $('downloadBtn'),
  smoothing: $('smoothing'),
  smoothingValue: $('smoothingValue'),
  clarity: $('clarity'),
  clarityValue: $('clarityValue'),
  lowCut: $('lowCut'),
  lowCutValue: $('lowCutValue'),
  rangeText: $('rangeText'),
  levelMeter: $('levelMeter'),
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BUFFER_SIZE = 8192;

let audioContext = null;
let stream = null;
let source = null;
let analyser = null;
let recorderNode = null;
let timeData = null;
let rafId = null;
let smoothedFrequency = null;
let lastGoodPitchAt = 0;
let isRecording = false;
let recordedChunks = [];
let recordedSampleRate = 48000;
let lastWavUrl = null;
let calibration = null;
let voiceProfile = loadProfile();

const tunerCtx = ui.tunerCanvas.getContext('2d');
const waveCtx = ui.waveCanvas.getContext('2d');

function setStatus(text, className = '') {
  ui.micStatus.textContent = text;
  ui.micStatus.className = `status-pill ${className}`.trim();
}

function updateSliderLabels() {
  ui.smoothingValue.textContent = `${Math.round(Number(ui.smoothing.value) * 100)}%`;
  ui.clarityValue.textContent = `${Math.round(Number(ui.clarity.value) * 100)}%`;
  ui.lowCutValue.textContent = `${ui.lowCut.value} Hz`;
}

ui.smoothing.addEventListener('input', updateSliderLabels);
ui.clarity.addEventListener('input', updateSliderLabels);
ui.lowCut.addEventListener('input', updateSliderLabels);
updateSliderLabels();
renderProfile();
drawTuner(null, 0);
drawWaveform(new Float32Array(BUFFER_SIZE));

ui.startBtn.addEventListener('click', startMic);
ui.stopBtn.addEventListener('click', stopMic);
ui.calibrateBtn.addEventListener('click', startCalibration);
ui.recordBtn.addEventListener('click', toggleRecording);
ui.downloadBtn.addEventListener('click', downloadLastTake);

async function startMic() {
  if (audioContext) return;

  try {
    setStatus('requesting mic');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: { ideal: 48000 },
      },
      video: false,
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ latencyHint: 'interactive' });
    recordedSampleRate = audioContext.sampleRate;

    source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = BUFFER_SIZE;
    analyser.smoothingTimeConstant = 0;
    timeData = new Float32Array(analyser.fftSize);

    recorderNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
    recorderNode.onaudioprocess = handleAudioProcess;

    source.connect(analyser);
    source.connect(recorderNode);
    recorderNode.connect(audioContext.destination);

    ui.startBtn.disabled = true;
    ui.stopBtn.disabled = false;
    ui.calibrateBtn.disabled = false;
    ui.recordBtn.disabled = false;
    setStatus('mic live', 'live');
    ui.pitchMessage.textContent = 'Sing a sustained note. The app listens for the strongest stable pitch.';
    pitchLoop();
  } catch (error) {
    console.error(error);
    setStatus('mic blocked');
    ui.pitchMessage.textContent = 'Microphone access failed. Use the GitHub Pages HTTPS link and allow mic permission.';
    stopMic();
  }
}

function stopMic() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  isRecording = false;
  calibration = null;
  smoothedFrequency = null;

  if (recorderNode) recorderNode.disconnect();
  if (source) source.disconnect();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (audioContext) audioContext.close();

  audioContext = null;
  stream = null;
  source = null;
  analyser = null;
  recorderNode = null;
  timeData = null;

  ui.startBtn.disabled = false;
  ui.stopBtn.disabled = true;
  ui.calibrateBtn.disabled = true;
  ui.recordBtn.disabled = true;
  ui.recordBtn.textContent = 'Record WAV';
  setStatus('mic idle');
  drawTuner(null, 0);
}

function handleAudioProcess(event) {
  const input = event.inputBuffer.getChannelData(0);
  const output = event.outputBuffer.getChannelData(0);
  output.fill(0);

  if (!isRecording) return;
  recordedChunks.push(new Float32Array(input));
}

function pitchLoop() {
  if (!analyser || !timeData) return;

  analyser.getFloatTimeDomainData(timeData);
  const level = rms(timeData);
  ui.levelMeter.style.width = `${Math.min(100, level * 420)}%`;
  drawWaveform(timeData);

  const minHz = Number(ui.lowCut.value);
  const detection = detectPitchYin(timeData, audioContext.sampleRate, minHz, 950);
  const minClarity = Number(ui.clarity.value);

  if (detection && detection.clarity >= minClarity) {
    const smoothing = Number(ui.smoothing.value);
    smoothedFrequency = smoothedFrequency
      ? smoothedFrequency * smoothing + detection.frequency * (1 - smoothing)
      : detection.frequency;
    lastGoodPitchAt = performance.now();
    updatePitchReadout(smoothedFrequency, detection.clarity);
    collectCalibration(smoothedFrequency, detection.clarity);
  } else if (performance.now() - lastGoodPitchAt > 450) {
    smoothedFrequency = null;
    ui.noteName.textContent = '--';
    ui.frequency.textContent = '0.0 Hz';
    ui.centsReadout.textContent = 'listening';
    drawTuner(null, level);
    if (!calibration) ui.pitchMessage.textContent = level < 0.015 ? 'Sing a little louder or move closer to the mic.' : 'Hold the note steadier.';
  }

  updateCalibrationPrompt();
  rafId = requestAnimationFrame(pitchLoop);
}

function updatePitchReadout(frequency, clarity) {
  const note = noteFromFrequency(frequency);
  const cents = centsOff(frequency, note.frequency);
  ui.noteName.textContent = note.name;
  ui.frequency.textContent = `${frequency.toFixed(1)} Hz`;
  ui.centsReadout.textContent = `${cents > 0 ? '+' : ''}${Math.round(cents)} cents`;
  drawTuner(cents, clarity);

  if (Math.abs(cents) <= 7) {
    ui.pitchMessage.textContent = `Locked on ${note.name}. Centered enough for a vocal take.`;
  } else if (cents < 0) {
    ui.pitchMessage.textContent = `${note.name} is flat. Lift it slightly.`;
  } else {
    ui.pitchMessage.textContent = `${note.name} is sharp. Relax it slightly.`;
  }
}

function detectPitchYin(buffer, sampleRate, minFrequency, maxFrequency) {
  const size = buffer.length;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const tauMax = Math.min(size - 2, Math.floor(sampleRate / minFrequency));
  const yin = new Float32Array(tauMax + 1);
  let energy = 0;

  for (let i = 0; i < size; i++) energy += buffer[i] * buffer[i];
  if (Math.sqrt(energy / size) < 0.01) return null;

  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0;
    const limit = size - tau;
    for (let i = 0; i < limit; i++) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    yin[tau] = sum;
  }

  let runningSum = 0;
  yin[0] = 1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    runningSum += yin[tau];
    yin[tau] = runningSum === 0 ? 1 : (yin[tau] * tau) / runningSum;
  }

  const threshold = 0.12;
  let tauEstimate = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (yin[tau] < threshold) {
      while (tau + 1 <= tauMax && yin[tau + 1] < yin[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate === -1) {
    let bestTau = tauMin;
    let bestValue = yin[tauMin];
    for (let tau = tauMin + 1; tau <= tauMax; tau++) {
      if (yin[tau] < bestValue) {
        bestValue = yin[tau];
        bestTau = tau;
      }
    }
    if (bestValue > 0.22) return null;
    tauEstimate = bestTau;
  }

  const betterTau = parabolicInterpolation(yin, tauEstimate);
  const frequency = sampleRate / betterTau;
  const clarity = Math.max(0, Math.min(1, 1 - yin[tauEstimate]));

  if (!Number.isFinite(frequency) || frequency < minFrequency || frequency > maxFrequency) return null;
  return { frequency, clarity };
}

function parabolicInterpolation(values, index) {
  const x0 = Math.max(0, index - 1);
  const x2 = Math.min(values.length - 1, index + 1);
  if (x0 === index || x2 === index) return index;

  const s0 = values[x0];
  const s1 = values[index];
  const s2 = values[x2];
  const denominator = (2 * s1) - s2 - s0;
  if (Math.abs(denominator) < 0.000001) return index;
  return index + (s2 - s0) / (2 * denominator);
}

function noteFromFrequency(frequency) {
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  const name = `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
  const noteFrequency = 440 * Math.pow(2, (midi - 69) / 12);
  return { midi, name, frequency: noteFrequency };
}

function centsOff(frequency, noteFrequency) {
  return 1200 * Math.log2(frequency / noteFrequency);
}

function rms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function drawTuner(cents, strength) {
  const canvas = ui.tunerCanvas;
  const ctx = tunerCtx;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fillRect(0, 0, w, h);

  const center = w / 2;
  const baseline = h * 0.68;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(40, baseline);
  ctx.lineTo(w - 40, baseline);
  ctx.stroke();

  for (let c = -50; c <= 50; c += 10) {
    const x = center + (c / 50) * (w * 0.42);
    const tall = c % 50 === 0 || c === 0;
    ctx.strokeStyle = c === 0 ? 'rgba(131,242,166,0.9)' : 'rgba(255,255,255,0.22)';
    ctx.lineWidth = c === 0 ? 4 : 2;
    ctx.beginPath();
    ctx.moveTo(x, baseline - (tall ? 54 : 30));
    ctx.lineTo(x, baseline + (tall ? 18 : 10));
    ctx.stroke();

    if (tall) {
      ctx.fillStyle = 'rgba(246,244,238,0.72)';
      ctx.font = '700 22px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(String(c), x, baseline + 50);
    }
  }

  const safeCents = cents === null ? 0 : Math.max(-50, Math.min(50, cents));
  const needleX = center + (safeCents / 50) * (w * 0.42);
  const glow = cents === null ? 0.16 : 0.34 + (strength || 0) * 0.35;

  ctx.strokeStyle = `rgba(255,223,112,${glow})`;
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.moveTo(center, h * 0.17);
  ctx.lineTo(needleX, baseline - 4);
  ctx.stroke();

  ctx.strokeStyle = cents !== null && Math.abs(cents) <= 7 ? '#83f2a6' : '#ffdf70';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(center, h * 0.17);
  ctx.lineTo(needleX, baseline - 4);
  ctx.stroke();

  ctx.fillStyle = cents === null ? 'rgba(255,255,255,0.34)' : '#f6f4ee';
  ctx.beginPath();
  ctx.arc(needleX, baseline - 4, 12, 0, Math.PI * 2);
  ctx.fill();
}

function drawWaveform(buffer) {
  const canvas = ui.waveCanvas;
  const ctx = waveCtx;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,223,112,0.88)';
  ctx.lineWidth = 3;
  ctx.beginPath();

  const step = Math.max(1, Math.floor(buffer.length / w));
  for (let x = 0; x < w; x++) {
    const sample = buffer[x * step] || 0;
    const y = h / 2 + sample * h * 0.42;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

function startCalibration() {
  if (!audioContext) return;
  calibration = {
    start: performance.now(),
    lows: [],
    highs: [],
  };
  ui.pitchMessage.textContent = 'Calibration started. Sing your lowest comfortable note.';
  ui.calibrateBtn.disabled = true;
}

function collectCalibration(frequency, clarity) {
  if (!calibration || clarity < Number(ui.clarity.value)) return;
  const elapsed = performance.now() - calibration.start;
  if (elapsed < 4200) calibration.lows.push(frequency);
  else if (elapsed < 8400) calibration.highs.push(frequency);
}

function updateCalibrationPrompt() {
  if (!calibration) return;
  const elapsed = performance.now() - calibration.start;
  const remaining = Math.max(0, 8.4 - elapsed / 1000).toFixed(1);

  if (elapsed < 4200) {
    ui.pitchMessage.textContent = `Calibration: sing your lowest comfortable note. ${remaining}s left.`;
  } else if (elapsed < 8400) {
    ui.pitchMessage.textContent = `Calibration: now sing your highest comfortable note. ${remaining}s left.`;
  } else {
    finishCalibration();
  }
}

function finishCalibration() {
  const lows = calibration.lows.slice().sort((a, b) => a - b);
  const highs = calibration.highs.slice().sort((a, b) => a - b);
  calibration = null;
  ui.calibrateBtn.disabled = false;

  if (lows.length < 6 || highs.length < 6) {
    ui.pitchMessage.textContent = 'Calibration did not catch enough stable notes. Try again with longer sustained notes.';
    return;
  }

  const low = percentile(lows, 0.18);
  const high = percentile(highs, 0.82);
  voiceProfile = {
    lowHz: low,
    highHz: high,
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem('dawVoiceProfile', JSON.stringify(voiceProfile));
  renderProfile();
  ui.pitchMessage.textContent = `Voice profile saved: ${noteFromFrequency(low).name} to ${noteFromFrequency(high).name}.`;
}

function percentile(sortedNumbers, p) {
  const index = Math.min(sortedNumbers.length - 1, Math.max(0, Math.round((sortedNumbers.length - 1) * p)));
  return sortedNumbers[index];
}

function renderProfile() {
  if (!voiceProfile) {
    ui.rangeText.textContent = 'No profile yet. Tap Calibrate Voice and sing your lowest comfortable note, then your highest comfortable note.';
    return;
  }
  const lowNote = noteFromFrequency(voiceProfile.lowHz);
  const highNote = noteFromFrequency(voiceProfile.highHz);
  ui.rangeText.textContent = `Saved range: ${lowNote.name} (${voiceProfile.lowHz.toFixed(1)} Hz) to ${highNote.name} (${voiceProfile.highHz.toFixed(1)} Hz). The detector keeps listening broadly, but this gives you a real vocal reference.`;
}

function loadProfile() {
  try {
    const raw = localStorage.getItem('dawVoiceProfile');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function toggleRecording() {
  if (!audioContext) return;

  if (!isRecording) {
    recordedChunks = [];
    recordedSampleRate = audioContext.sampleRate;
    isRecording = true;
    ui.recordBtn.textContent = 'Stop Recording';
    ui.downloadBtn.disabled = true;
    setStatus('recording wav', 'recording');
    ui.pitchMessage.textContent = 'Recording WAV. Sing normally; pitch monitoring stays active.';
  } else {
    isRecording = false;
    ui.recordBtn.textContent = 'Record WAV';
    setStatus('mic live', 'live');
    makeLastTakeDownloadable();
  }
}

function makeLastTakeDownloadable() {
  if (!recordedChunks.length) {
    ui.pitchMessage.textContent = 'No audio was captured.';
    return;
  }

  const samples = flattenChunks(recordedChunks);
  const wavBlob = encodeWav(samples, recordedSampleRate);
  if (lastWavUrl) URL.revokeObjectURL(lastWavUrl);
  lastWavUrl = URL.createObjectURL(wavBlob);
  ui.downloadBtn.disabled = false;
  const seconds = samples.length / recordedSampleRate;
  ui.pitchMessage.textContent = `WAV ready: ${seconds.toFixed(1)} seconds at ${recordedSampleRate} Hz.`;
}

function downloadLastTake() {
  if (!lastWavUrl) return;
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = lastWavUrl;
  link.download = `daw-vocal-take-${stamp}.wav`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function flattenChunks(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
}
