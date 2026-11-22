# KeyShift

See and hear a piano tutorial in the key you play it in. Open a tutorial recorded in Eb, pick Db, and KeyShift shows the notes falling onto a keyboard in Db, plays the tutorial audio in Db, and lists every chord in both keys.

- **Open a tutorial:** any audio or video file (MP4, MOV, M4A, MP3, WAV), up to 40 minutes. From MP4, MOV and M4A files KeyShift reads only the sound, so a large screen recording opens in seconds without filling the memory. On a phone, screen-record the YouTube video with sound on, then open the recording.
- **Record a tab (desktop Chrome or Edge):** press Record a tab, pick the YouTube tab, turn on "Also share tab audio", play the part you want, then press Stop recording.
- **Transcribe:** starts by itself on the whole file (up to 20 minutes at a time; change Start and End to do less). Notes and chords appear half a minute at a time, so you can play what is ready while the rest is written out. Stop keeps what is done. Use Low sensitivity when the teacher talks over the playing.
- **Key:** KeyShift guesses the original key. Change "Played in" if the teacher names a different one, then pick the key you want. Nearest, Up and Down choose which way it moves (Eb to Db is down 2).
- **Player:** notes fall onto a keyboard with their names (red right hand, blue left hand below middle C). Drag the notes to scrub. Previous and next jump by chord, the loop button repeats the current chord, and Speed slows the audio down to 50% without changing the pitch. Hear the tutorial audio, the written-out notes, or both.
- **Chord chart:** big name in the new key, small name as the tutorial plays it. Tap one to jump there.
- **Save:** a MIDI file and a chord sheet, both in the new key.
- **Private:** the note model (Spotify's Basic Pitch) runs in the browser. Files are not uploaded.

Keys: Space plays or pauses, Left and Right move by chord, L loops the chord.

## Changing it

`index.html` is built from `source/`. Do not edit it by hand.

```
cd keyshift/source
npm ci
npm run build
```

The build writes `../index.html` (the app, the note model and the example, all in one file).

## Credits

- Basic Pitch by Spotify, Apache License 2.0.
- mp4box.js, BSD 3-Clause License.
- Signalsmith Stretch by Signalsmith Audio, MIT License.
- TensorFlow.js, Apache License 2.0. @tonejs/midi, MIT License.
