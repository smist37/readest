// How far ahead TTS audio is prepared (decoded + time-stretched), shared by
// the player's in-paragraph lookahead and the client's paragraph openings.
// Its own module so tests that mock WebAudioPlayer keep working.

// Seconds of prepared (decoded + stretched) audio to keep ahead of the
// playhead, in wall-clock time at the playback rate. Decode + WSOLA of a
// sentence takes up to ~1s on a phone, so a fixed chunk count drains on a run
// of short sentences; the scheduler keeps preparing until this much is queued.
// Also the target BufferedTTSClient prepares for each upcoming paragraph's
// opening. Memory: ~192 KB per second at 48 kHz mono float (8s ≈ 1.5 MB).
export const PREPARED_AHEAD_SEC = 8;

// One idle slice: work queued past the bare minimum yields to rendering and
// input between chunks instead of running as one main-thread burst.
export const idleTick = (): Promise<void> =>
  new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
      .requestIdleCallback;
    if (typeof ric === 'function') ric(() => resolve(), { timeout: 250 });
    else setTimeout(resolve, 0);
  });
