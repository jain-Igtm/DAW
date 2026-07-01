# DAW Voice Pitch Monitor

A tiny browser-based vocal tool for singing practice on mobile.

## What it does

- Starts the phone or computer microphone from a GitHub Pages HTTPS page.
- Detects your sung pitch in real time with a YIN-style pitch tracker.
- Shows the nearest note, frequency, and cents sharp/flat.
- Draws a tuner needle and live waveform.
- Lets you calibrate your comfortable vocal range and stores it in local browser storage.
- Records uncompressed 16-bit mono WAV directly from the microphone.

## Use

1. Open the GitHub Pages site for this repository.
2. Tap **Start Mic** and allow microphone permission.
3. Sing a steady note.
4. Watch the tuner:
   - center = in tune
   - left = flat
   - right = sharp
5. Tap **Record WAV** to capture a take.
6. Tap **Download Last Take** to save it.

## Important notes

This app has to run over HTTPS for microphone access. GitHub Pages provides HTTPS automatically once Pages is enabled for the repo.

For the cleanest vocal recording, use wired earbuds or keep the phone speaker quiet. The app asks the browser for raw microphone input with echo cancellation, noise suppression, and auto gain disabled, but each phone/browser can still make its own hardware decisions.

## Files

- `index.html` — app layout
- `styles.css` — mobile-first visual design
- `app.js` — mic engine, pitch detector, tuner, calibration, and WAV encoder
