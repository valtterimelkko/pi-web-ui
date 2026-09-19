#!/usr/bin/env node
/**
 * Browser validation for the P13 playback-observability gap fill.
 *
 * The unit tests inject the health reporter, so they cannot prove that the REAL
 * surface, in a REAL browser, actually uploads. This runs the dev-lab page (the
 * real `VoiceLiveSurface` on a real `AudioContext`), intercepts `window.fetch`,
 * feeds a sequence gap, and stops playback — then asserts the two uploads the
 * operator needs: the fault, and the lane-end summary carrying the stranded
 * audio measured BEFORE the queue was cleared.
 *
 * Usage: node scripts/validate-playback-health-browser.mjs --url <lab page url>
 */
import { chromium } from 'playwright';

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const URL = flag('url');
if (!URL) {
  console.error('usage: --url <http://127.0.0.1:PORT/client/voice-live-lab.html>');
  process.exit(2);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Record every POST to the diagnostics route; the page's own fetch is left alone. */
const INTERCEPT = `(() => {
  window.__healthPosts = [];
  const original = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/client-diagnostics') && init && typeof init.body === 'string') {
        window.__healthPosts.push(JSON.parse(init.body));
      }
    } catch (error) {
      window.__healthPosts.push({ __parseError: String(error) });
    }
    return original.apply(this, arguments);
  };
})();`;

const main = async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.addInitScript(INTERCEPT);
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.__voiceLiveLab), { timeout: 60_000 });
    await page.evaluate(async () => {
      await window.__voiceLiveLab.arm();
    });
    record('dev lab page armed with the real surface', true);

    const lane = await page.evaluate(() => window.__voiceLiveLab.lane());

    // 26 x 100 ms of speech: the horizon holds ~2 s, so ~0.6 s stays pending.
    await page.evaluate(async ({ laneId, attachmentGeneration }) => {
      const frame = (seq) => ({
        type: 'voice_audio_chunk',
        version: 1,
        laneId,
        attachmentGeneration,
        seq,
        mimeType: 'audio/pcm;rate=24000',
        data: btoa(String.fromCharCode(...new Uint8Array(4800))),
        durationMs: 100,
        atMs: seq * 100,
      });
      // seq 1 is never delivered: a real sequence gap, reported by the pipeline.
      window.__voiceLiveLab.deliverRaw(frame(0));
      window.__voiceLiveLab.deliverRaw(frame(2));
      for (let seq = 3; seq < 26; seq++) window.__voiceLiveLab.deliverRaw(frame(seq));
    }, lane);

    const afterFault = await page.evaluate(() => window.__healthPosts.slice());
    const gap = afterFault.find((p) => p.reason === 'playback_seq_gap');
    record('a real browser uploaded the sequence-gap fault', Boolean(gap), gap ? `reason=${gap.reason}` : 'no upload');
    record(
      'the fault upload carried the stats at the moment it happened',
      Boolean(gap) && typeof gap.stats?.chunksScheduled === 'number' && gap.kind === 'playback_health',
      gap ? `kind=${gap.kind} chunksScheduled=${gap.stats?.chunksScheduled}` : 'no upload',
    );
    record(
      'the upload carries the lane worker-session correlation',
      Boolean(gap) && gap.workerSessionId === lane.workerSessionId,
      gap ? `workerSessionId=${gap.workerSessionId} (lane=${lane.workerSessionId})` : 'no upload',
    );

    const beforeStop = await page.evaluate(() => window.__voiceLiveLab.playback());
    await page.evaluate(() => window.__voiceLiveLab.stopPlayback());

    const afterStop = await page.evaluate(() => window.__healthPosts.slice());
    const laneEnd = afterStop.find((p) => p.reason === 'lane_end');
    record('a real browser uploaded the lane-end summary', Boolean(laneEnd), laneEnd ? 'reason=lane_end' : 'no upload');
    record(
      'the lane-end summary carries the STRANDED audio, measured before the queue was cleared',
      Boolean(laneEnd) && laneEnd.stats?.pendingMs > 0,
      laneEnd ? `pendingMs=${laneEnd.stats?.pendingMs} pendingChunks=${laneEnd.stats?.pendingChunks} (pre-stop pending=${beforeStop?.pendingMs})` : 'no upload',
    );
    const afterStopPending = await page.evaluate(() => window.__voiceLiveLab.playback());
    record(
      'and it is genuinely pre-reset (the pipeline reports zero pending afterwards)',
      afterStopPending?.pendingChunks === 0,
      `post-stop pendingChunks=${afterStopPending?.pendingChunks}`,
    );

    record('no page errors during the run', pageErrors.length === 0, pageErrors.join('; ').slice(0, 200));

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length === 0 ? 0 : 1);
  } finally {
    await browser.close();
  }
};

main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exit(2);
});
