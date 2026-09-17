These four cues are rendered from [Cuelume](https://github.com/Danilaa1/cuelume)
0.2.2, by Daniel Belyi, under the included MIT license. The upstream synthesis,
gain, envelopes, and echo are preserved in mono 44.1 kHz, 16-bit PCM WAV files.

Regenerate with `node scripts/generate-sounds.mjs` (Node 22+ and npm).
The renderer installs its pinned dependencies only under `.yet-build`.
The WAVs are embedded in Yet's bundle, including standalone builds, and cached
under `~/.yet/sounds/cuelume-0.2.2` for native playback. macOS uses `afplay`, Linux
uses `pw-play`, `paplay`, or `aplay`, and Windows uses PowerShell's SoundPlayer.
Playback is silent when no player or audio device is available.
