// lib/textStats.js is a hand-synced COPY of TwitchBot/shared/textStats.js (the repos may not
// import each other). These tests exist to pin its behaviour: if someone edits the bot's copy and
// re-syncs, or edits this copy alone, the cases below are what catch the drift - and drift here is
// not cosmetic. The per-user word cloud tokenizes raw `messages` at read time and must reproduce
// exactly what the bot produced when it wrote ChatWordStats; if the two tokenizers disagree, a
// user's cloud silently stops agreeing with the channel's.
const test = require("node:test");
const assert = require("node:assert/strict");

const { extractWords, extractMentions, isCommandMessage, dayBucket, LIFETIME_BUCKET, STOPWORDS } = require("../lib/textStats");

test("extractWords: strips Twitch's invisible anti-duplicate padding", () => {
  // Real messages in the DB contain U+034F (COMBINING GRAPHEME JOINER); without stripping it the
  // tokenizer emits invisible "words".
  assert.deepEqual(extractWords("привет͏"), ["привет"]);
  assert.deepEqual(extractWords("hello​﻿"), ["hello"]);
});

test("extractWords: command invocations contribute nothing", () => {
  // "!countmsg vlad" must not put "vlad" in the word cloud - a command is not conversation.
  assert.deepEqual(extractWords("!countmsg vlad"), []);
  assert.deepEqual(extractWords("#counter привет"), []);
  assert.equal(isCommandMessage("  !ban someone"), true);
  assert.equal(isCommandMessage("just talking"), false);
});

test("extractWords: drops stopwords, URLs, numbers and bare punctuation", () => {
  assert.deepEqual(extractWords("что это такое сегодня"), ["сегодня"]);
  assert.deepEqual(extractWords("check https://twitch.tv/x"), ["check"]);
  assert.deepEqual(extractWords("123 --- пиццу!!!"), ["пиццу"]);
});

test("extractWords: a word counts once per message no matter how often it repeats", () => {
  // Matches the semantics addMessage() already used for the emote counters, so the collections
  // stay comparable.
  assert.deepEqual(extractWords("тест тест тест"), ["тест"]);
});

test("extractWords: emotes are excluded via the caller's predicate, case-insensitively", () => {
  // The real predicate is whiteList UNION WordLifetimeStats, lowercased - see wordStatsRepo.
  const emotes = new Set(["arolf", "jokerge"]);
  const isEmote = (t) => emotes.has(String(t).toLowerCase());
  assert.deepEqual(extractWords("AROLF привет Jokerge", isEmote), ["привет"]);
});

test("extractWords: an emote next to punctuation is still an emote (regression)", () => {
  // Regression: the emote check originally ran ONLY on the raw token, so "alarm," and "Jokerge!"
  // failed to match the whitelist verbatim, survived the check, then got stripped to
  // "alarm"/"jokerge" and were counted as WORDS. Measured against the real corpus this had put
  // 113 distinct emotes into the word index.
  const emotes = new Set(["alarm", "jokerge"]);
  const isEmote = (t) => emotes.has(String(t).toLowerCase());

  assert.deepEqual(extractWords("alarm, привет Jokerge!", isEmote), ["привет"]);
  assert.deepEqual(extractWords("(Jokerge)", isEmote), []);
  assert.deepEqual(extractWords("...alarm...", isEmote), []);
});

test("extractWords: caps how much one message can contribute", () => {
  const spam = Array.from({ length: 200 }, (_, i) => `слово${i}`).join(" ");
  assert.equal(extractWords(spam).length, 30);
});

test("extractMentions: lowercases, dedupes, and ignores self-mentions", () => {
  assert.deepEqual(extractMentions("@SomeUser привет", ["vlad_261"]), ["someuser"]);
  assert.deepEqual(extractMentions("@vlad_261 hi", ["Vlad_261"]), []);
  assert.deepEqual(extractMentions("@a_bc yo @a_bc @d_ef", []), ["a_bc", "d_ef"]);
});

test("extractMentions: an email address is not a mention", () => {
  assert.deepEqual(extractMentions("mail me at foo@gmail", []), []);
});

test("extractMentions: a command's target is not a social mention", () => {
  assert.deepEqual(extractMentions("!ban @baduser", []), []);
});

test("extractMentions: caps mentions per message", () => {
  const spam = Array.from({ length: 20 }, (_, i) => `@user${i}`).join(" ");
  assert.equal(extractMentions(spam, []).length, 5);
});

test("dayBucket: buckets at local noon, matching the existing `words` collection", () => {
  const bucket = dayBucket(new Date("2026-07-12T23:47:00"));
  assert.equal(bucket.getHours(), 12);
  assert.equal(bucket.getMinutes(), 0);
  assert.equal(bucket.getSeconds(), 0);
});

test("LIFETIME_BUCKET is the epoch, so real date ranges exclude the all-time row", () => {
  assert.equal(LIFETIME_BUCKET.getTime(), 0);
  const anyRealWindowStart = new Date("2020-01-01");
  assert.ok(LIFETIME_BUCKET < anyRealWindowStart);
});

test("stopword list contains no non-Russian/non-English junk", () => {
  // Guards a mistake made (twice) while writing the list by hand.
  const junk = [...STOPWORDS].filter((w) => !/^[а-яё]+$/.test(w) && !/^[a-z]+$/.test(w));
  assert.deepEqual(junk, []);
});
