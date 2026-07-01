# DAW Vocal Lab

A tiny browser-based vocal tool for singing practice on mobile.

## What it does

- Starts the phone or computer microphone from a GitHub Pages HTTPS page.
- Detects your sung pitch in real time with a YIN-style pitch tracker.
- Shows the nearest note, frequency, and cents sharp/flat.
- Draws a tuner needle and live waveform.
- Lets you calibrate your comfortable vocal range and stores it in local browser storage.
- Records uncompressed 16-bit mono WAV directly from the microphone.
- Adds a **Retune Vocals** tab for simple browser-based vocal pitch correction.
- Lets you upload a vocal file or reuse the last recorded take.
- Retunes toward a selected key and scale, with controls for correction amount, snap speed, max shift, and detection gate.
- Exports the retuned result as a downloadable 16-bit mono WAV.

## Use: Pitch Monitor

1. Open the GitHub Pages site for this repository.
2. Tap **Start Mic** and allow microphone permission.
3. Sing a steady note.
4. Watch the tuner:
   - center = in tune
   - left = flat
   - right = sharp
5. Tap **Record WAV** to capture a take.
6. Tap **Download Last Take** to save it.

## Use: Retune Vocals

1. Open the **Retune Vocals** tab.
2. Upload a dry solo vocal file, or record a take in the Pitch Monitor tab and tap **Use Last Recorded Take**.
3. Pick the key and scale.
4. Adjust the retune settings:
   - **Correction amount** controls how far notes move toward the target pitch.
   - **Snap speed** controls how quickly pitch locks to the target.
   - **Max shift** prevents huge unnatural jumps.
   - **Detection gate** ignores unclear/noisy frames.
5. Tap **Retune Vocal**.
6. Preview the result and download the corrected WAV.

## Important notes

This app has to run over HTTPS for microphone access. GitHub Pages provides HTTPS automatically once Pages is enabled for the repo.

For the cleanest vocal recording, use wired earbuds or keep the phone speaker quiet. The app asks the browser for raw microphone input with echo cancellation, noise suppression, and auto gain disabled, but each phone/browser can still make its own hardware decisions.

The retune tool is lightweight and runs fully in the browser. It is best for dry monophonic vocals. It will not behave like Melodyne or a full commercial Auto-Tune plugin, and it can smear or warble if the vocal is mixed with a beat, stacked with doubles, noisy, or extremely off-pitch.

## Files

- `index.html` — app layout and tabs
- `styles.css` — mobile-first visual design
- `app.js` — mic engine, pitch detector, tuner, calibration, WAV encoder, and retune processor
