# Pad and Loop Station

A black and white web app for church: loops on the left, worship pads on the right.

- **Pads:** all 12 keys. Tap a key to start, tap another to crossfade, and press Stop pad (or Esc) to cut it off at once. Four sounds: Warm, Shimmer, Strings and Air. Three chords: Open (root and fifth, fits major and minor songs), Major and Minor. The pads are made live in the browser, so there are no pad files and no loop point.
- **Loops:** add MP3, WAV, M4A or AIFF files, or drag in a whole folder. Drop them anywhere on the page. They loop with no gap and stay saved in the browser on that device. Set the tempo with +/-, the slider or Tap tempo; the pitch stays the same. Each loop's own BPM is read from the file name (for example `Afro 98bpm.wav`) or worked out from its length. Check it and type over it if it's wrong. While a loop plays, tap another one and it switches at the next bar, at the end of the loop, or straight away.
- **Invert colours:** the button at the top switches between white on black and black on white. It remembers your choice.
- **Works offline:** after you open it once, it opens with no internet.

## Open it

Open the app's web address in Chrome or Safari.

**Install it like an app (recommended for Sunday):**

- **Mac, Chrome:** click **Install app** at the top of the page, or the install icon at the right of the address bar.
- **Mac, Safari (macOS Sonoma or newer):** File > Add to Dock.
- **iPhone or iPad:** Share > Add to Home Screen.
- **Android:** the browser menu > Install app.

After that it opens from its own icon, offline, with your loops and settings where you left them.

Your loops are saved in that browser on that device only. On a new device, add them once.

## Run it on your own computer

Any small web server works, because the offline feature needs `http://` rather than opening the file directly:

```
cd pad-loop-station
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Updating

When you change any file, bump `VERSION` in `sw.js` so installed copies pick up the change.

## Credits

- Tempo change without pitch change: [SoundTouch JS](https://github.com/cutterbl/SoundTouchJS), LGPL-2.1 (`js/SOUNDTOUCH-LICENSE.txt`).
- Fonts: Barlow Condensed and IBM Plex Sans, SIL Open Font License 1.1 (`fonts/`).
