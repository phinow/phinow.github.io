# KeyShift

See and hear a piano tutorial in the key you play it in. Open a tutorial recorded in Eb, pick Db, and KeyShift shows the notes falling onto a keyboard in Db, plays the tutorial audio in Db, and lists every chord in both keys.

- **Open a tutorial:** any audio or video file (MP3, M4A, WAV, MP4). On a phone, screen-record the YouTube video with sound on, then open the recording.
- **Record a tab (desktop Chrome or Edge):** press Record a tab, pick the YouTube tab, turn on "Also share tab audio", play the part you want, then press Stop recording.
- **Transcribe:** pick the part of the file where the song is played (up to 10 minutes) and press Transcribe. Files of 3 minutes or less start on their own. Use Low sensitivity when the teacher talks over the playing.
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
- Signalsmith Stretch by Signalsmith Audio, MIT License.
- TensorFlow.js, Apache License 2.0. @tonejs/midi, MIT License.
