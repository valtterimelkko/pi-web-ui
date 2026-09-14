/**
 * Audio lab harness — a lab-only browser entrypoint (see harness.html).
 *
 * It gives the lab a real browser audio graph it can drive with known inputs,
 * so a measurement failure can be attributed to the capture chain rather than
 * to the product. It deliberately uses the SAME primitives the product does:
 * a single shared `AudioContext`, `decodeAudioData` for MP3, a
 * `GainNode` between source and destination, and resumption inside a real user
 * gesture (never a muted or autoplay-bypassed shortcut).
 *
 * Everything is exposed on `window.__audioLab` for Playwright to drive, and
 * every action appends a structured event with a `performance.now()` stamp so
 * the report can correlate intent with the independently captured audio.
 */

(function () {
  'use strict';

  var context = null;
  var active = [];
  var events = [];
  var seq = 0;

  function nowMs() {
    return Math.round(performance.now() * 1000) / 1000;
  }

  function log(entry) {
    events.push(Object.assign({ seq: seq++, t: nowMs() }, entry));
    var el = document.getElementById('log');
    if (el) el.textContent = JSON.stringify(events.slice(-6), null, 1);
  }

  function getContext() {
    if (!context) context = new AudioContext();
    return context;
  }

  function base64ToArrayBuffer(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  window.__audioLab = {
    /** Create and resume the shared AudioContext inside a user gesture. */
    arm: function () {
      var ctx = getContext();
      return ctx.resume().then(function () {
        log({ event: 'armed', contextState: ctx.state, sampleRate: ctx.sampleRate });
        return { state: ctx.state, sampleRate: ctx.sampleRate };
      });
    },

    /** Play a pure tone through GainNode -> destination. */
    playTone: function (frequencyHz, durationMs, amplitude) {
      var ctx = getContext();
      var gain = ctx.createGain();
      gain.gain.value = amplitude === undefined ? 0.6 : amplitude;
      var osc = ctx.createOscillator();
      osc.frequency.value = frequencyHz;
      osc.connect(gain);
      gain.connect(ctx.destination);
      var startedAt = nowMs();
      osc.start();
      osc.stop(ctx.currentTime + durationMs / 1000);
      var handle = { osc: osc, gain: gain };
      active.push(handle);
      osc.addEventListener('ended', function () {
        var index = active.indexOf(handle);
        if (index >= 0) active.splice(index, 1);
        log({ event: 'tone_end', frequencyHz: frequencyHz, durationMs: durationMs, startedAt: startedAt });
      });
      log({
        event: 'tone_start',
        frequencyHz: frequencyHz,
        durationMs: durationMs,
        contextState: ctx.state,
        sampleRate: ctx.sampleRate,
      });
      return { startedAt: startedAt, contextState: ctx.state, sampleRate: ctx.sampleRate };
    },

    /** Decode and play encoded audio bytes (MP3 fixtures) exactly once. */
    playBytes: function (base64, playbackRate) {
      var ctx = getContext();
      var rate = playbackRate === undefined ? 1 : playbackRate;
      var startedAt = nowMs();
      return ctx.decodeAudioData(base64ToArrayBuffer(base64)).then(function (buffer) {
        var source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        var gain = ctx.createGain();
        gain.gain.value = 1;
        source.connect(gain);
        gain.connect(ctx.destination);
        var handle = { source: source, gain: gain };
        active.push(handle);
        source.addEventListener('ended', function () {
          var index = active.indexOf(handle);
          if (index >= 0) active.splice(index, 1);
          log({ event: 'bytes_end', durationSeconds: buffer.duration });
        });
        source.start(0);
        log({
          event: 'bytes_start',
          durationSeconds: buffer.duration,
          sampleRate: buffer.sampleRate,
          channels: buffer.numberOfChannels,
          playbackRate: rate,
          decodeMs: Math.round((nowMs() - startedAt) * 1000) / 1000,
        });
        return {
          durationSeconds: buffer.duration,
          sampleRate: buffer.sampleRate,
          channels: buffer.numberOfChannels,
        };
      });
    },

    /** Stop everything currently playing (explicit cancel, never ducking). */
    stopAll: function () {
      active.forEach(function (handle) {
        try {
          if (handle.osc) handle.osc.stop();
          if (handle.source) handle.source.stop();
        } catch (error) {
          /* already stopped */
        }
      });
      active = [];
      log({ event: 'stop_all' });
      return true;
    },

    /** Live gain change on whatever is playing (models barge-in ducking). */
    setGain: function (value) {
      active.forEach(function (handle) {
        handle.gain.gain.value = value;
      });
      log({ event: 'set_gain', value: value });
      return active.length;
    },

    state: function () {
      return {
        contextState: context ? context.state : 'none',
        sampleRate: context ? context.sampleRate : 0,
        activeCount: active.length,
      };
    },

    events: function () {
      return events.slice();
    },
  };

  var armButton = document.getElementById('arm');
  if (armButton) {
    armButton.addEventListener('click', function () {
      window.__audioLab.arm();
    });
  }
  var silenceButton = document.getElementById('silence');
  if (silenceButton) {
    silenceButton.addEventListener('click', function () {
      log({ event: 'rendered_nothing' });
    });
  }
})();
