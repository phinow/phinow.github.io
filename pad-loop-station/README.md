# Loopadicious

Loop + pad + delicious. A black and white web app for church: loops on the left, worship pads on the right.

- **Pads:** all 12 keys. Tap a key to start, tap another to crossfade, and press Stop pad (or Esc) to cut it off at once. Four sounds: Warm, Shimmer, Strings and Air. Three chords: Open (root and fifth, fits major and minor songs), Major and Minor. The pads are made live in the browser, so there are no pad files and no loop point.
- **Loop slots:** Worship has 3/4, 4/4 and Finger snap. Praise has Woro, Highlife and Praise. Drop a file on a slot (or tap the slot to choose one). Add more slots with **+ Add a worship loop** or **+ Add a praise loop**, and rename any slot. Keys 1 to 9 pick a slot, Space plays or stops.
- **Long files:** anything over 30 seconds opens the trimmer. Pick the tempo, 3/4 or 4/4, how many bars (1, 2, 4 or 8) and where it starts, preview it, then keep just that loop. Only the trimmed part is saved, so a big WAV becomes a small loop. Use **Trim** on any slot to shorten a loop later.
- **Tempo:** set it with +/-, the slider or Tap tempo; the pitch stays the same. While a loop plays, pick another and it switches at the next bar, at the end of the loop, or straight away. MP3, WAV, M4A and AIFF all work, and loops stay saved in the browser on that device.
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
- Fonts: Unbounded, Barlow Condensed and IBM Plex Sans, SIL Open Font License 1.1 (`fonts/`).
