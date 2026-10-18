import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { TTSController } from '@/services/tts/TTSController';
import type { SpeechProvider, SpeechSynthesisResult } from '@/services/tts/providers/types';
import { FakeAudioContext, FakeAudioBuffer } from './tts-fake-audio';

// Paragraph boundary with every sentence already in memory: the next
// paragraph's session only starts after the last chunk's onended, so any
// decode + WSOLA for its first sentence runs while the speakers are silent.
// Decode here costs DECODE_SEC of audio-clock time to model a slow phone.

let parsedMarks: Array<{ name: string; text: string; language: string }> = [];
vi.mock('@/utils/ssml', () => ({
  parseSSMLMarks: vi.fn(() => ({ marks: parsedMarks })),
}));
vi.mock('@/utils/misc', () => ({
  getUserLocale: vi.fn((lang: string) => (lang === 'en' ? 'en-US' : lang)),
  getOSPlatform: vi.fn(() => 'android'),
  stubTranslation: (key: string) => key,
}));
vi.mock('@/services/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/environment')>()),
  isTauriAppPlatform: () => false,
}));
vi.mock('@/services/tts/TTSUtils', () => ({
  TTSUtils: {
    getPreferredVoice: vi.fn(() => null),
    sortVoicesPreferLocaleFunc: () => () => 0,
  },
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});

const DECODE_SEC = 0.5;
// "Tiny ..." sentences are 0.2 s at 1.0x ("Yes."), "Short ..." 1 s, the rest 3 s.
const audioBytes = (text: string) =>
  text.startsWith('Tiny') ? 9600 : text.startsWith('Short') ? 48000 : 144000;
const GAP_SEC = 0.2;
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('paragraph boundary on cache hits', () => {
  let client: InstanceType<typeof import('@/services/tts/BufferedTTSClient').BufferedTTSClient>;
  let ctx: FakeAudioContext;

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    FakeAudioContext.instances = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    await import('@/services/tts/EdgeTTSClient');
    const { BufferedTTSClient } = await import('@/services/tts/BufferedTTSClient');
    const provider: SpeechProvider = {
      id: 'mem',
      label: 'Mem',
      cacheable: true,
      init: async () => true,
      getAllVoices: async () => [{ id: 'v1', name: 'Voice 1', lang: 'en-US' }],
      // Every sentence a cache hit: no latency at all.
      synthesize: async (req): Promise<SpeechSynthesisResult> => ({
        // Fake decoder: byteLength / 2 samples at 24 kHz.
        audio: new ArrayBuffer(audioBytes(req.text)),
        // One boundary spanning the sentence, as Edge reports word timings.
        boundaries: [{ offset: 0, duration: (audioBytes(req.text) / 48000) * 1e7, text: req.text }],
      }),
    };
    const controller = {
      dispatchSpeakMark: vi.fn(),
      prepareSpeakWords: vi.fn(),
      dispatchSpeakWord: vi.fn(),
    } as unknown as TTSController;
    client = new BufferedTTSClient(provider, controller);
    await client.init();
    await client.setRate(1.5);
    client.setParagraphGap(GAP_SEC);
  });

  afterEach(() => vi.unstubAllGlobals());

  const installSlowDecode = () => {
    ctx = FakeAudioContext.instances.at(-1)!;
    ctx.decodeImpl = async (data) => {
      // The audio clock keeps running while the main thread decodes.
      ctx.currentTime += DECODE_SEC;
      const samples = new Float32Array(data.byteLength / 2);
      // Audible throughout, so silence trimming keeps the whole sentence.
      for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin(i / 8);
      return new FakeAudioBuffer(samples, ctx.sampleRate);
    };
  };

  const run = (marks: typeof parsedMarks, preload = false) => {
    parsedMarks = marks;
    const codes: string[] = [];
    const done = (async () => {
      for await (const e of await client.speak('<ssml/>', new AbortController().signal, preload))
        codes.push(e.code);
    })();
    return { codes, done };
  };

  const para = (p: string) => [
    { name: `${p}0`, text: `${p} one.`, language: 'en' },
    { name: `${p}1`, text: `${p} two.`, language: 'en' },
  ];

  test('the pause between paragraphs is the scheduled gap, not decode time', async () => {
    // Paragraph A plays.
    const a = run(para('A'));
    await flush();
    installSlowDecode();
    // Controller's preloadNextSSML during A: paragraph B, all cache hits.
    const pre = run(para('B'), true);
    await pre.done;
    await flush();
    // Play A out: session-end only after the last chunk's onended.
    const aSources = () => ctx.sources.slice();
    let lastEnd = 0;
    for (let i = 0; i < 50 && !a.codes.includes('end'); i++) {
      const pending = ctx.sources.filter((s) => !s.endedFired && !s.stopped);
      const t = Math.max(ctx.currentTime, ...pending.map((s) => s.endTime));
      await ctx.advanceTo(t);
      await flush();
    }
    await a.done;
    lastEnd = Math.max(...aSources().map((s) => s.endTime));
    const before = ctx.sources.length;
    // Controller: forward() -> current-paragraph preload -> speak(B).
    await run(para('B'), true).done;
    run(para('B'));
    await flush();
    const firstB = ctx.sources[before]!;
    const pause = firstB.startedAt! - lastEnd;
    expect(pause).toBeCloseTo(GAP_SEC, 2);
  }, 30_000);

  // The user's case: four one-line paragraphs, then a long one. Drives the
  // client the way TTSController does: preload the paragraph, speak it, and on
  // its first event preload the paragraphs after it; advance on session end.
  test('no gap longer than the scheduled pauses after a run of short paragraphs', async () => {
    client.setSentenceGap(0.1);
    const long = (p: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `${p}${i}`,
        text: `${p} long ${i}.`,
        language: 'en',
      }));
    const short = (p: string) => [{ name: `${p}0`, text: `Short ${p}.`, language: 'en' }];
    const paragraphs = [long('A', 6), short('B'), short('C'), short('D'), short('E'), long('F', 6)];
    let ctxReady = false;
    for (let p = 0; p < paragraphs.length; p++) {
      await run(paragraphs[p]!, true).done;
      const session = run(paragraphs[p]!);
      if (!ctxReady) {
        await flush();
        installSlowDecode();
        ctxReady = true;
      }
      let preloaded = false;
      for (let step = 0; step < 2000 && !session.codes.includes('end'); step++) {
        if (!preloaded && session.codes.length > 0) {
          preloaded = true;
          // Preloads run in the background in the controller.
          void (async () => {
            for (const next of paragraphs.slice(p + 1, p + 17)) await run(next, true).done;
          })();
        }
        await ctx.advanceTo(ctx.currentTime + 0.05);
        await flush();
      }
      await session.done;
    }
    const played = ctx.sources
      // Played to the end (a handover stop()s sources that already ended).
      .filter((s) => s.startedAt !== null && s.endedFired)
      .sort((a, b) => a.startedAt! - b.startedAt!);
    let worst = 0;
    for (let i = 1; i < played.length; i++) {
      worst = Math.max(worst, played[i]!.startedAt! - played[i - 1]!.endTime);
    }
    expect(played.length).toBe(16);
    expect(worst).toBeLessThanOrEqual(GAP_SEC + 0.01);
  }, 60_000);

  // Inside one paragraph: a run of one-word sentences plays out faster than
  // one decode + WSOLA, so a lookahead of two chunks drains and the speakers
  // stop after a short sentence.
  test('no gap after short sentences inside a paragraph', async () => {
    client.setSentenceGap(0.05);
    const marks = [
      { name: 'p0', text: 'P long 0.', language: 'en' },
      ...Array.from({ length: 4 }, (_, i) => ({
        name: `t${i}`,
        text: `Tiny ${i}.`,
        language: 'en',
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        name: `p${i + 1}`,
        text: `P long ${i + 1}.`,
        language: 'en',
      })),
    ];
    const session = run(marks);
    await flush();
    installSlowDecode();
    for (let step = 0; step < 2000 && !session.codes.includes('end'); step++) {
      await ctx.advanceTo(ctx.currentTime + 0.05);
      await flush();
    }
    await session.done;
    const played = ctx.sources
      .filter((s) => s.startedAt !== null && s.endedFired)
      .sort((a, b) => a.startedAt! - b.startedAt!);
    let worst = 0;
    for (let i = 1; i < played.length; i++) {
      worst = Math.max(worst, played[i]!.startedAt! - played[i - 1]!.endTime);
    }
    expect(played.length).toBe(8);
    expect(worst).toBeLessThanOrEqual(0.05 + 0.01);
  }, 30_000);
});
