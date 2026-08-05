// Shared encoder/decoder for solo-game replay logs - the input journal a game
// records while you play and submits instead of a bare score, so the server can
// re-simulate the run and compute the score itself (see lib/gameReplay/).
//
// Same placement rule as minesweeperEngine.js: this repo has no JS bundler, so
// lib/ never reaches the browser. A file both sides need lives under
// public/js/games/engines/ and exports itself as a CommonJS module OR a browser
// global depending on which environment loads it. The server require()s it out
// of public/.
//
// The codec is deliberately GAME-AGNOSTIC. It never learns any game's opcode
// table: how many argument bytes an event carries, and whether an event counts
// as real human input, are encoded in the action byte itself. That's what lets
// lib/gameReplay/inputHeuristics.js analyse timing for a game it knows nothing
// about, and lets a new game ship without touching this file.
//
// Wire format (then base64url, unpadded - no form-encoding escapes):
//
//   header   "R1"        2 bytes  magic
//            gameId      u8       GAME_IDS below
//            rules       u8       engine's RULES_VERSION
//            seed        varint   server-issued (echoed for debugging only -
//                                 the server always replays with its OWN seed)
//            count       varint   number of events
//   event    dtMs        varint   ms since the previous event, clamped [0,60000]
//            action      u8       see ACTION BYTE below
//            args        0-3 bytes
//   trailer  durationMs  varint   client's end-of-run offset from run start
//            claimed     varint   client's own score (compared, never trusted)
//
// ACTION BYTE: 0bAA_S_OOOOO
//   bits 7-6  argCount (0-3) - how many u8 argument bytes follow
//   bit  5    synthetic - this event was DERIVED, not a discrete human action:
//             an OS key auto-repeat, or one step of a drag gesture that emitted
//             several moves from a single pointer event. Timing heuristics must
//             skip these, otherwise holding an arrow key (perfectly regular
//             ~33ms OS repeat) reads as a bot. See inputHeuristics.js.
//   bits 4-0  opcode (0-31), meaning defined by each game's engine
"use strict";

// Wrapped in an IIFE (unlike the per-game engine files) because this is the
// one file EVERY solo game page loads alongside its own engine <script> - two
// top-level `const`/`let` scripts share one global lexical scope, so an
// unwrapped `const api` here collided with each engine file's own top-level
// `const api`, throwing a SyntaxError that silently killed this script (and
// with it window.ReplayCodec, and with THAT every "play" button) on all six
// games. Node's own module wrapper already isolates the require()'d copy;
// this only needs to protect the plain <script> case.
(function () {

const MAGIC_0 = 0x52; // 'R'
const MAGIC_1 = 0x31; // '1'

// Stable numeric ids - never renumber, a replay in flight carries the old one.
const GAME_IDS = {
  "falling-blocks": 1,
  "pipe-dodger": 2,
  2048: 3,
  minesweeper: 4,
  "match-3": 5,
  "cloud-climber": 6,
};

// A single event's dt can never legitimately exceed a minute: a backgrounded
// tab must not be able to emit a four-hour varint and claim the run lasted that
// long. Clamped on the way in AND on the way out - clamping at decode can only
// SHRINK a claimed duration, which makes the server's `simElapsed <=
// serverElapsed` check easier to pass, so it can never cost an honest player a
// run while still denying a forger any way to inflate simulated time.
const MAX_EVENT_DT_MS = 60000;

// Per-game payload ceilings, checked before decoding. Derived from realistic
// worst-case run lengths at ~2-3 bytes per event; falling-blocks and 2048 are
// the two unbounded-length games and are exactly the two that checkpoint
// mid-run, so no single request ever carries their full log.
const LIMITS = {
  minesweeper: { maxBytes: 16 * 1024, maxEvents: 4000 },
  "match-3": { maxBytes: 16 * 1024, maxEvents: 3000 },
  "pipe-dodger": { maxBytes: 64 * 1024, maxEvents: 20000 },
  2048: { maxBytes: 256 * 1024, maxEvents: 100000 },
  "falling-blocks": { maxBytes: 256 * 1024, maxEvents: 150000 },
  "cloud-climber": { maxBytes: 4 * 1024, maxEvents: 64 },
};

// Deterministic PRNG, promoted here so every game shares one implementation and
// the client/server pair provably draw the same stream. minesweeperEngine.js
// keeps its own identical copy on purpose - changing that file would be a
// gratuitous edit to a module wave-1 agents are told not to touch, and its
// tests assert against it.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ReplayFormatError(message) {
  const err = new Error(message);
  err.name = "ReplayFormatError";
  err.replayFormat = true;
  return err;
}

// ---------------------------------------------------------------- byte buffer

function ByteWriter() {
  this.bytes = [];
}
ByteWriter.prototype.u8 = function (value) {
  this.bytes.push(value & 0xff);
};
// Unsigned LEB128.
ByteWriter.prototype.varint = function (value) {
  let v = Math.max(0, Math.floor(value));
  for (;;) {
    const byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v === 0) {
      this.bytes.push(byte);
      return;
    }
    this.bytes.push(byte | 0x80);
  }
};

function ByteReader(bytes) {
  this.bytes = bytes;
  this.pos = 0;
}
ByteReader.prototype.u8 = function () {
  if (this.pos >= this.bytes.length) throw ReplayFormatError("truncated: expected a byte");
  return this.bytes[this.pos++];
};
ByteReader.prototype.varint = function () {
  let result = 0;
  let shift = 1;
  // 5 bytes covers any value we encode (durations, scores, a uint32 seed);
  // more than that is a malformed or deliberately overlong encoding.
  for (let i = 0; i < 5; i++) {
    const byte = this.u8();
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return result;
    shift *= 128;
  }
  throw ReplayFormatError("varint overrun");
};

// ------------------------------------------------------------ base64url (both)

function bytesToBase64Url(bytes) {
  let base64;
  if (typeof Buffer !== "undefined") {
    base64 = Buffer.from(bytes).toString("base64");
  } else {
    // Chunked - String.fromCharCode.apply on a 256kB array blows the stack.
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode.apply(null, bytes.slice(i, i + 8192));
    }
    base64 = btoa(binary);
  }
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) {
    throw ReplayFormatError("replay is not base64url");
  }
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof Buffer !== "undefined") {
    return Array.from(Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const out = new Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------- recorder

// `now` is injectable so tests can drive a run without real time passing. The
// client passes a performance.now() reader.
//
// Deliberately records the RAW time of the DOM event, not the time of the
// simulation step that consumed it. Timestamping at the step would quantize
// every dt to the fixed timestep, which both destroys the timing signal the
// heuristics rely on and makes every honest player look like a script.
function createRecorder(options) {
  const gameId = GAME_IDS[options.gameKey];
  if (!gameId) throw new Error("unknown gameKey: " + options.gameKey);
  const clock = options.now || (() => Date.now());

  const events = [];
  const startedAt = clock();
  let lastAt = startedAt;

  return {
    gameKey: options.gameKey,
    seed: options.seed >>> 0,

    // opcode 0-31; a, b, c are optional u8 arguments; `synthetic` marks a
    // derived event (auto-repeat, one step of a drag) so heuristics skip it.
    push(opcode, a, b, c, synthetic) {
      const at = clock();
      const dt = Math.min(MAX_EVENT_DT_MS, Math.max(0, Math.round(at - lastAt)));
      lastAt = at;
      const args = [];
      if (a !== undefined && a !== null) args.push(a & 0xff);
      if (b !== undefined && b !== null) args.push(b & 0xff);
      if (c !== undefined && c !== null) args.push(c & 0xff);
      events.push({ dt, opcode: opcode & 0x1f, args, synthetic: Boolean(synthetic) });
    },

    eventCount() {
      return events.length;
    },

    elapsedMs() {
      return Math.round(clock() - startedAt);
    },

    // Serializes events [from, end). `from` lets the leave-page beacon send
    // only the tail after a mid-run checkpoint already banked the head.
    encode(claimedScore, from) {
      return encodeEvents({
        gameKey: options.gameKey,
        rulesVersion: options.rulesVersion,
        seed: options.seed,
        events: from ? events.slice(from) : events,
        totalDurationMs: Math.round(clock() - startedAt),
        claimedScore,
      });
    },

    // Raw events, for 2048's localStorage resume (it re-runs its own log to
    // rebuild a restored board - see public/js/games/2048.js).
    snapshot() {
      return events.slice();
    },
    restore(saved) {
      events.length = 0;
      for (const ev of saved) events.push(ev);
      lastAt = clock();
    },
  };
}

function encodeEvents(input) {
  const gameId = GAME_IDS[input.gameKey];
  if (!gameId) throw new Error("unknown gameKey: " + input.gameKey);
  const w = new ByteWriter();
  w.u8(MAGIC_0);
  w.u8(MAGIC_1);
  w.u8(gameId);
  w.u8(input.rulesVersion & 0xff);
  w.varint(input.seed >>> 0);
  w.varint(input.events.length);
  for (const ev of input.events) {
    const args = ev.args || [];
    if (args.length > 3) throw new Error("at most 3 argument bytes per event");
    w.varint(Math.min(MAX_EVENT_DT_MS, Math.max(0, ev.dt | 0)));
    w.u8((args.length << 6) | (ev.synthetic ? 0x20 : 0) | (ev.opcode & 0x1f));
    for (const arg of args) w.u8(arg);
  }
  w.varint(input.totalDurationMs);
  w.varint(Math.max(0, input.claimedScore | 0));
  return bytesToBase64Url(w.bytes);
}

// -------------------------------------------------------------------- decoder

// Throws ReplayFormatError on anything malformed. `limits` is LIMITS[gameKey];
// both ceilings are checked BEFORE the event loop runs, so an oversized payload
// costs one header parse rather than a full decode.
function decode(text, limits) {
  const cap = limits || {};
  if (cap.maxBytes && text.length > Math.ceil((cap.maxBytes * 4) / 3) + 8) {
    throw ReplayFormatError("replay exceeds maxBytes");
  }

  const bytes = base64UrlToBytes(text);
  if (cap.maxBytes && bytes.length > cap.maxBytes) throw ReplayFormatError("replay exceeds maxBytes");

  const r = new ByteReader(bytes);
  if (r.u8() !== MAGIC_0 || r.u8() !== MAGIC_1) throw ReplayFormatError("bad magic");
  const gameId = r.u8();
  const rulesVersion = r.u8();
  const seed = r.varint();
  const count = r.varint();
  if (cap.maxEvents && count > cap.maxEvents) throw ReplayFormatError("replay exceeds maxEvents");

  const events = new Array(count);
  let simElapsedMs = 0;
  for (let i = 0; i < count; i++) {
    const dt = Math.min(MAX_EVENT_DT_MS, r.varint());
    const action = r.u8();
    const argCount = (action >> 6) & 0x03;
    const args = new Array(argCount);
    for (let k = 0; k < argCount; k++) args[k] = r.u8();
    simElapsedMs += dt;
    events[i] = {
      dt,
      at: simElapsedMs,
      opcode: action & 0x1f,
      synthetic: (action & 0x20) !== 0,
      args,
      a: argCount > 0 ? args[0] : undefined,
      b: argCount > 1 ? args[1] : undefined,
      c: argCount > 2 ? args[2] : undefined,
    };
  }

  const totalDurationMs = r.varint();
  const claimedScore = r.varint();
  // A forged `count` that doesn't match the real payload shows up here: either
  // the reader ran out of bytes above, or bytes are left over.
  if (r.pos !== bytes.length) throw ReplayFormatError("trailing bytes after replay");

  return {
    gameId,
    gameKey: Object.keys(GAME_IDS).find((k) => GAME_IDS[k] === gameId) || null,
    rulesVersion,
    seed,
    events,
    // Sum of event dts. `totalDurationMs` is the client's own claim of when the
    // run ended, which can be later than the last event (you die a while after
    // your last keypress) - drivers use whichever their game's clock needs.
    eventSpanMs: simElapsedMs,
    totalDurationMs,
    claimedScore,
    byteLength: bytes.length,
  };
}

const api = {
  GAME_IDS,
  LIMITS,
  MAX_EVENT_DT_MS,
  mulberry32,
  createRecorder,
  encodeEvents,
  decode,
  ReplayFormatError,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
} else {
  window.ReplayCodec = api;
}

})();
