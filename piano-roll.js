(() => {
  const els = {
    canvas: document.getElementById('pianoCanvas'),
    analyzeBtn: document.getElementById('analyzePianoBtn'),
    applyBtn: document.getElementById('applyPianoBtn'),
    clearBtn: document.getElementById('clearPianoBtn'),
    info: document.getElementById('selectedClipInfo'),
    retuneMessage: document.getElementById('retuneMessage'),
    retunedAudio: document.getElementById('retunedAudio'),
    downloadRetunedBtn: document.getElementById('downloadRetunedBtn'),
    rootNote: document.getElementById('rootNote'),
    scaleName: document.getElementById('scaleName'),
    correctionAmount: document.getElementById('correctionAmount'),
    snapSpeed: document.getElementById('snapSpeed'),
    maxShift: document.getElementById('maxShift'),
    retuneGate: document.getElementById('retuneGate'),
  };

  if (!els.canvas) return;

  const ctx = els.canvas.getContext('2d');
  const state = {
    clips: [],
    selectedIndex: -1,
    dragging: false,
    duration: 1,
    minMidi: 48,
    maxMidi: 72,
    pitchFrames: [],
  };

  const baseSetRetuneInput = setRetuneInput;
  setRetuneInput = function patchedSetRetuneInput(...args) {
    const result = baseSetRetuneInput(...args);
    resetPianoRoll('Loaded vocal. Tap Analyze Piano Roll to create draggable note blocks.');
    updatePianoButtons();
    return result;
  };

  els.analyzeBtn.addEventListener('click', analyzePianoRoll);
  els.applyBtn.addEventListener('click', applyPianoRoll);
  els.clearBtn.addEventListener('click', () => resetPianoRoll('Blocks cleared. Tap Analyze Piano Roll to rebuild them.'));
  els.canvas.addEventListener('pointerdown', handlePointerDown);
  els.canvas.addEventListener('pointermove', handlePointerMove);
  els.canvas.addEventListener('pointerup', handlePointerUp);
  els.canvas.addEventListener('pointercancel', handlePointerUp);
  window.addEventListener('resize', () => drawPianoRoll());

  updatePianoButtons();
  drawPianoRoll();

  function updatePianoButtons() {
    els.analyzeBtn.disabled = !retuneInput;
    els.applyBtn.disabled = !retuneInput || state.clips.length === 0;
    els.clearBtn.disabled = state.clips.length === 0;
  }

  function resetPianoRoll(message) {
    state.clips = [];
    state.selectedIndex = -1;
    state.dragging = false;
    state.pitchFrames = [];
    state.duration = retuneInput ? Math.max(1, retuneInput.samples.length / retuneInput.sampleRate) : 1;
    state.minMidi = 48;
    state.maxMidi = 72;
    els.info.textContent = message;
    updatePianoButtons();
    drawPianoRoll();
  }

  async function analyzePianoRoll() {
    if (!retuneInput) return;

    els.analyzeBtn.disabled = true;
    els.applyBtn.disabled = true;
    els.clearBtn.disabled = true;
    setStatus('analyzing', 'working');
    els.info.textContent = 'Analyzing vocal into pitch blocks...';

    const frames = [];
    const samples = retuneInput.samples;
    const sampleRate = retuneInput.sampleRate;
    const detectionSize = 4096;
    const hop = 512;
    const windowBuffer = new Float32Array(detectionSize);
    const gate = Number(els.retuneGate.value);
    const total = Math.max(1, Math.ceil(samples.length / hop));
    let smoothMidi = null;

    for (let frame = 0, center = 0; center < samples.length; frame++, center += hop) {
      localFillCenteredWindow(samples, windowBuffer, center);
      const detection = detectPitchYin(windowBuffer, sampleRate, 60, 950);
      let midi = null;
      let used = false;

      if (detection && detection.clarity >= gate) {
        const rawMidi = midiFromFrequency(detection.frequency);
        smoothMidi = smoothMidi === null ? rawMidi : smoothMidi * 0.72 + rawMidi * 0.28;
        midi = smoothMidi;
        used = true;
      } else {
        smoothMidi = null;
      }

      frames.push({
        time: center / sampleRate,
        midi,
        used,
      });

      if (frame % 32 === 0) {
        els.info.textContent = `Analyzing vocal into pitch blocks... ${Math.min(99, Math.round((frame / total) * 100))}%`;
        await waitForPaint();
      }
    }

    state.pitchFrames = frames;
    state.duration = Math.max(1, samples.length / sampleRate);
    state.clips = buildClipsFromFrames(frames);
    fitMidiRange();
    state.selectedIndex = state.clips.length ? 0 : -1;
    updatePianoButtons();
    drawPianoRoll();

    if (!state.clips.length) {
      els.info.textContent = 'No clean pitch blocks found. Try a louder/drier vocal or lower the Detection Gate.';
      setStatus('analysis empty');
      return;
    }

    const selected = state.clips[state.selectedIndex];
    els.info.textContent = `${state.clips.length} blocks found. Drag blocks up/down to place snippets on notes. Selected: ${clipLabel(selected)}.`;
    setStatus('piano ready', 'live');
  }

  function buildClipsFromFrames(frames) {
    const clips = [];
    let active = null;
    let lastVoicedTime = 0;
    let lastNote = null;
    const minFrames = 3;

    for (const frame of frames) {
      if (!frame.used || frame.midi === null) {
        if (active && frame.time - lastVoicedTime > 0.15) {
          finishActiveClip();
        }
        continue;
      }

      const note = Math.round(frame.midi);
      const shouldSplit = active && (
        frame.time - lastVoicedTime > 0.15 ||
        (Math.abs(note - lastNote) >= 1 && active.frames.length >= minFrames)
      );

      if (!active || shouldSplit) {
        finishActiveClip();
        active = { frames: [], note };
      }

      active.frames.push(frame);
      active.note = note;
      lastNote = note;
      lastVoicedTime = frame.time;
    }

    finishActiveClip();
    return mergeTinyClips(clips).map((clip, index) => ({ ...clip, id: index + 1 }));

    function finishActiveClip() {
      if (!active || active.frames.length < minFrames) {
        active = null;
        return;
      }

      const first = active.frames[0];
      const last = active.frames[active.frames.length - 1];
      const sourceMidi = median(active.frames.map((point) => point.midi));
      const targetMidi = nearestMidiInScale(sourceMidi, Number(els.rootNote.value), els.scaleName.value);
      const start = Math.max(0, first.time - 0.025);
      const end = Math.min(state.duration, last.time + 0.05);
      if (end - start >= 0.07) clips.push({ start, end, sourceMidi, targetMidi });
      active = null;
    }
  }

  function mergeTinyClips(clips) {
    if (clips.length < 2) return clips;
    const merged = [];

    for (const clip of clips) {
      const prev = merged[merged.length - 1];
      if (prev && clip.end - clip.start < 0.09 && clip.start - prev.end < 0.08) {
        const prevWeight = Math.max(0.01, prev.end - prev.start);
        const clipWeight = Math.max(0.01, clip.end - clip.start);
        prev.end = clip.end;
        prev.sourceMidi = (prev.sourceMidi * prevWeight + clip.sourceMidi * clipWeight) / (prevWeight + clipWeight);
        prev.targetMidi = Math.round((prev.targetMidi * prevWeight + clip.targetMidi * clipWeight) / (prevWeight + clipWeight));
      } else {
        merged.push({ ...clip });
      }
    }

    return merged;
  }

  async function applyPianoRoll() {
    if (!retuneInput || !state.clips.length) return;

    els.applyBtn.disabled = true;
    els.analyzeBtn.disabled = true;
    els.clearBtn.disabled = true;
    setStatus('piano retune', 'working');
    els.info.textContent = 'Applying piano roll retune...';

    const params = {
      amount: Number(els.correctionAmount.value),
      snap: Number(els.snapSpeed.value),
      maxCents: Number(els.maxShift.value),
      gate: Number(els.retuneGate.value),
    };

    try {
      const result = await retuneWithPianoRoll(retuneInput.samples, retuneInput.sampleRate, state.clips, params, (progress, map) => {
        els.info.textContent = `Applying piano roll retune... ${progress}%`;
        if (map && map.length) drawRetuneMap(map);
      });

      const blob = encodeWav(result.samples, retuneInput.sampleRate);
      if (retunedUrl) URL.revokeObjectURL(retunedUrl);
      retunedUrl = URL.createObjectURL(blob);
      els.retunedAudio.src = retunedUrl;
      els.downloadRetunedBtn.disabled = false;
      drawRetuneMap(result.map);
      els.retuneMessage.textContent = 'Piano roll retune ready. Preview the result, then download the WAV.';
      els.info.textContent = `Applied ${state.clips.length} piano-roll blocks. Download or keep editing the blocks and apply again.`;
      setStatus('piano ready', 'live');
    } catch (error) {
      console.error(error);
      els.info.textContent = 'Piano roll retune failed. Try a shorter dry vocal first.';
      setStatus('piano failed');
    } finally {
      updatePianoButtons();
    }
  }

  async function retuneWithPianoRoll(input, sampleRate, clips, params, progressFn) {
    const frameSize = 2048;
    const detectionSize = 4096;
    const hop = 512;
    const output = new Float32Array(input.length);
    const weights = new Float32Array(input.length);
    const win = hannWindow(frameSize);
    const detectionWindow = new Float32Array(detectionSize);
    const map = [];
    const maxSemis = params.maxCents / 100;
    const response = 0.05 + params.snap * 0.72;
    const totalFrames = Math.max(1, Math.ceil(input.length / hop));
    let shiftSemis = 0;
    let clipIndex = 0;

    for (let frameIndex = 0, center = 0; center < input.length; frameIndex++, center += hop) {
      const time = center / sampleRate;
      while (clipIndex < clips.length - 1 && clips[clipIndex].end < time) clipIndex++;
      const clip = clips[clipIndex] && time >= clips[clipIndex].start && time <= clips[clipIndex].end ? clips[clipIndex] : null;

      localFillCenteredWindow(input, detectionWindow, center);
      const detection = detectPitchYin(detectionWindow, sampleRate, 60, 950);
      let used = false;
      let sourceMidi = null;
      let targetMidi = clip ? clip.targetMidi : null;
      let centsShift = 0;

      if (clip && detection && detection.clarity >= params.gate) {
        sourceMidi = midiFromFrequency(detection.frequency);
        const desiredShift = clamp((clip.targetMidi - sourceMidi) * params.amount, -maxSemis, maxSemis);
        shiftSemis += (desiredShift - shiftSemis) * response;
        centsShift = shiftSemis * 100;
        used = true;
      } else {
        shiftSemis *= 0.84;
        centsShift = shiftSemis * 100;
      }

      const ratio = Math.pow(2, shiftSemis / 12);
      overlapPitchFrame(input, output, weights, center, frameSize, ratio, win);
      map.push({ time, used, sourceMidi, targetMidi, centsShift });

      if (frameIndex % 18 === 0) {
        progressFn(Math.min(99, Math.round((frameIndex / totalFrames) * 100)), map);
        await waitForPaint();
      }
    }

    for (let i = 0; i < output.length; i++) {
      output[i] = weights[i] > 0.000001 ? output[i] / weights[i] : input[i] || 0;
    }

    softLimit(output);
    progressFn(100, map);
    return { samples: output, map };
  }

  function handlePointerDown(event) {
    if (!state.clips.length) return;
    const point = canvasPoint(event);
    const index = findClipAt(point.x, point.y);
    if (index < 0) return;

    state.selectedIndex = index;
    state.dragging = true;
    els.canvas.classList.add('dragging');
    els.canvas.setPointerCapture(event.pointerId);
    moveSelectedToY(point.y);
    drawPianoRoll();
    event.preventDefault();
  }

  function handlePointerMove(event) {
    if (!state.dragging || state.selectedIndex < 0) return;
    const point = canvasPoint(event);
    moveSelectedToY(point.y);
    drawPianoRoll();
    event.preventDefault();
  }

  function handlePointerUp(event) {
    state.dragging = false;
    els.canvas.classList.remove('dragging');
    try { els.canvas.releasePointerCapture(event.pointerId); } catch {}
  }

  function moveSelectedToY(y) {
    const clip = state.clips[state.selectedIndex];
    if (!clip) return;
    clip.targetMidi = clamp(Math.round(midiFromY(y)), state.minMidi, state.maxMidi);
    els.info.textContent = `Selected block ${clip.id}: ${clipLabel(clip)}. Drag up/down, then tap Apply Piano Roll.`;
  }

  function findClipAt(x, y) {
    for (let i = state.clips.length - 1; i >= 0; i--) {
      const box = clipBox(state.clips[i]);
      if (x >= box.x && x <= box.x + box.w && y >= box.y - 10 && y <= box.y + box.h + 10) return i;
    }

    const time = timeFromX(x);
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < state.clips.length; i++) {
      const clip = state.clips[i];
      const distance = time < clip.start ? clip.start - time : time > clip.end ? time - clip.end : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    return bestDistance < 0.18 ? bestIndex : -1;
  }

  function drawPianoRoll() {
    const canvas = els.canvas;
    const w = canvas.width;
    const h = canvas.height;
    const left = 58;
    const right = 14;
    const top = 18;
    const bottom = 28;
    const gridW = w - left - right;
    const gridH = h - top - bottom;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    ctx.fillRect(0, 0, w, h);

    for (let midi = state.minMidi; midi <= state.maxMidi; midi++) {
      const y = yFromMidi(midi);
      const pitchClass = ((midi % 12) + 12) % 12;
      const black = [1, 3, 6, 8, 10].includes(pitchClass);
      ctx.fillStyle = black ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.018)';
      ctx.fillRect(left, y - rowHeight() / 2, gridW, rowHeight());
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(w - right, y);
      ctx.stroke();

      if (pitchClass === 0 || midi === state.minMidi || midi === state.maxMidi) {
        ctx.fillStyle = 'rgba(246,244,238,0.62)';
        ctx.font = '700 14px system-ui';
        ctx.textAlign = 'right';
        ctx.fillText(noteNameFromMidi(midi), left - 8, y + 5);
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    for (let beat = 0; beat <= 8; beat++) {
      const x = left + (beat / 8) * gridW;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, h - bottom);
      ctx.stroke();
    }

    if (state.pitchFrames.length) {
      ctx.strokeStyle = 'rgba(185,183,200,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (const frame of state.pitchFrames) {
        if (!frame.used || frame.midi === null) {
          started = false;
          continue;
        }
        const x = xFromTime(frame.time);
        const y = yFromMidi(frame.midi);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    for (let i = 0; i < state.clips.length; i++) {
      drawClip(state.clips[i], i === state.selectedIndex);
    }

    if (!state.clips.length) {
      ctx.fillStyle = 'rgba(246,244,238,0.66)';
      ctx.font = '800 22px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Piano roll blocks will appear here', w / 2, h / 2);
    }
  }

  function drawClip(clip, selected) {
    const box = clipBox(clip);
    ctx.fillStyle = selected ? 'rgba(255,223,112,0.94)' : 'rgba(255,223,112,0.68)';
    ctx.strokeStyle = selected ? 'rgba(131,242,166,0.95)' : 'rgba(255,255,255,0.26)';
    ctx.lineWidth = selected ? 4 : 2;
    roundRect(ctx, box.x, box.y, Math.max(8, box.w), box.h, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#171102';
    ctx.font = '900 14px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(noteNameFromMidi(clip.targetMidi), box.x + 8, box.y + box.h / 2 + 5);
  }

  function clipBox(clip) {
    const x = xFromTime(clip.start);
    const x2 = xFromTime(clip.end);
    const y = yFromMidi(clip.targetMidi) - rowHeight() * 0.42;
    return {
      x,
      y,
      w: Math.max(10, x2 - x),
      h: Math.max(16, rowHeight() * 0.84),
    };
  }

  function fitMidiRange() {
    const midis = [];
    for (const clip of state.clips) midis.push(clip.sourceMidi, clip.targetMidi);
    for (const frame of state.pitchFrames) if (frame.used && frame.midi !== null) midis.push(frame.midi);

    if (!midis.length) {
      state.minMidi = 48;
      state.maxMidi = 72;
      return;
    }

    let min = Math.floor(Math.min(...midis)) - 4;
    let max = Math.ceil(Math.max(...midis)) + 4;
    if (max - min < 18) {
      const center = Math.round((min + max) / 2);
      min = center - 9;
      max = center + 9;
    }
    state.minMidi = clamp(min, 24, 96);
    state.maxMidi = clamp(max, state.minMidi + 12, 108);
  }

  function xFromTime(time) {
    const left = 58;
    const right = 14;
    return left + (time / Math.max(0.001, state.duration)) * (els.canvas.width - left - right);
  }

  function timeFromX(x) {
    const left = 58;
    const right = 14;
    return clamp((x - left) / Math.max(1, els.canvas.width - left - right), 0, 1) * state.duration;
  }

  function yFromMidi(midi) {
    const top = 18;
    const bottom = 28;
    const span = Math.max(1, state.maxMidi - state.minMidi);
    return top + ((state.maxMidi - midi) / span) * (els.canvas.height - top - bottom);
  }

  function midiFromY(y) {
    const top = 18;
    const bottom = 28;
    const span = Math.max(1, state.maxMidi - state.minMidi);
    const normalized = clamp((y - top) / Math.max(1, els.canvas.height - top - bottom), 0, 1);
    return state.maxMidi - normalized * span;
  }

  function rowHeight() {
    return Math.max(12, (els.canvas.height - 46) / Math.max(1, state.maxMidi - state.minMidi));
  }

  function canvasPoint(event) {
    const rect = els.canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * els.canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * els.canvas.height,
    };
  }

  function localFillCenteredWindow(input, buffer, center) {
    const half = Math.floor(buffer.length / 2);
    for (let i = 0; i < buffer.length; i++) buffer[i] = input[center + i - half] || 0;
  }

  function median(numbers) {
    const sorted = numbers.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 60;
  }

  function noteNameFromMidi(midi) {
    const rounded = Math.round(midi);
    return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
  }

  function clipLabel(clip) {
    return `${noteNameFromMidi(clip.sourceMidi)} → ${noteNameFromMidi(clip.targetMidi)}`;
  }

  function roundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }
})();
