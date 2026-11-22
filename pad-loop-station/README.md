# Loopadicious

Loop + pad + delicious. A black and white web app for church: loops on the left, worship pads on the right.

- **Pads:** all 12 keys, four to a row. Tap a key to start, tap another to crossfade, and press Stop pad (or Esc) to cut it off at once. Four sounds: Warm, Shimmer, Strings and Air. Three chords: Open (root and fifth, fits major and minor songs), Major and Minor. The pads are made live in the browser, so there are no pad files and no loop point.
- **Loop slots:** a 3 by 3 box. Worship: 3/4, 4/4, Finger snap. Praise: Woro, Highlife, Praise. More: three spare slots to fill and rename later. Drop a file on a slot (or tap it to choose one). The ••• button on each slot sets its tempo, checks the loop, trims, replaces, renames or clears it. **+ Slot** adds another. Keys 1 to 9 pick a slot, Space plays or stops.
- **Long files:** anything over 30 seconds opens the trimmer. Pick the tempo, 3/4 or 4/4, how many bars (1, 2, 4 or 8) and where it starts, preview it, then keep just that loop. Only the trimmed part is saved, so a big WAV becomes a small loop. Use **Trim** in a slot's ••• menu to shorten a loop later.
- **Tempo:** set it with +/-, the slider or Tap tempo; the pitch stays the same and every hit lands exactly on the grid (no doubled or chopped hits). At a loop's own tempo the original recording plays untouched. Loops play on the browser's audio thread, so a busy computer cannot make them stutter. While a loop plays, a tempo change takes over on the next beat. Pick another loop and it switches at the next bar, at the end of the loop, or straight away. MP3, WAV, M4A and AIFF all work, and loops stay saved in the browser on that device.
- **Check loop:** in a slot's ••• menu. Tells you if the loop's end does not meet its start cleanly (a click each time it repeats), if the file is not a whole number of beats (each pass would land early or late), or if its own tempo is set wrong. New loops are checked as you add them.
- **Self-test:** the link at the bottom of the app (`test.html`). Plays test loops through the real player and checks them sample by sample (own tempo, other tempos, every kind of switch, and playing while the computer is frozen), then checks every loop saved in your slots. It only reads your loops and settings.
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

- Fonts: Unbounded, Barlow Condensed and IBM Plex Sans, SIL Open Font License 1.1 (`fonts/`).
