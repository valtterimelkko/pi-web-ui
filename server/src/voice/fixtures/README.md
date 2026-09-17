# Voice fixtures

## `handshake-speech-16k.pcm`

Genuine spoken audio for the live handshake probe (`npm run test:voice-handshake`):
raw **PCM signed 16-bit little-endian, mono, 16 000 Hz** (the exact format
`VOICE_AUDIO_INPUT_FORMAT` describes), 1.9 s / 60 800 bytes.

- Content: the spoken phrase "Voice bridge handshake check, audio path verified."
- Provenance: synthesised locally with the Supertonic TTS engine (voice `F1`,
  `speed=1.05`, `total_steps=10`), resampled from 44.1 kHz to 16 kHz mono with
  FFmpeg (silence trimmed). No network, no external recording, no synthetic tone.
- Why committed: the plan's anti-cheat rule forbids sine-wave or digital-silence
  drivers for audio fixtures; the probe must send real speech so the provider's
  input transcription can be a meaningful check.
- Regenerate (if ever needed): synthesise the phrase locally, trim leading and
  trailing silence, then
  `ffmpeg -i in.wav -ac 1 -ar 16000 -f s16le handshake-speech-16k.pcm`.
