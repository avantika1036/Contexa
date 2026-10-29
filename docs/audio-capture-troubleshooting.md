# Audio capture troubleshooting

## Expected flow

1. Create/select an active meeting; wait until the UI says the session is connected.
2. Confirm consent.
3. Choose **Microphone only** to test `getUserMedia` before testing tab audio.
4. The status panel shows the permission request, recorder state, chunk delivery, or a specific failure reason.
5. The FastAPI console logs `Audio capture start message` followed by `Audio chunk received` entries when binary audio reaches the server.

## If microphone capture still fails

- Open the app on `http://127.0.0.1:5173`; local loopback is a secure context for browser media access.
- Check the site microphone permission in Chrome/Edge and Windows Settings > Privacy & security > Microphone.
- Check the selected microphone and its input level in Windows sound settings.
- Stop other applications that may exclusively hold the microphone.
- Observe the UI status panel and FastAPI terminal together. If there is an `Audio capture start message` but no chunk log, the issue is between `MediaRecorder` and `WebSocket.send`. If there is no start log, inspect permission and API messages in the UI.

## Browser tab audio

Use the browser picker to select a Chrome Tab containing the meeting and explicitly enable **Share tab audio**. Some sharing targets do not supply an audio track.

## Meeting history

The sidebar's Meeting history button scrolls to and focuses the session selector, where active and ended sessions can be selected. Ended sessions are retained for history but cannot accept new audio.

Audio chunks are currently acknowledged and measured only; this code does not transcribe or persist raw audio.
