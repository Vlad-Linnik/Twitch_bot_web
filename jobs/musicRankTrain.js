// Once a day: the learnt weights of the music graph (lib/musicRank.js) out of its journal - one model for
// every channel together and one for each channel with enough of a journal of its own. The learning runs
// in a worker: on a full journal it is seconds of arithmetic, which the site's process cannot spare.
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

if (!isMainThread) {
  const { train } = require("../lib/musicRank");
  parentPort.postMessage(train(workerData.events, { now: workerData.now }));
  return;
}

const musicEventsRepo = require("../db/musicEventsRepo");
const musicModelRepo = require("../db/musicModelRepo");
const { ROWS_MIN } = require("../lib/musicRank");
const models = require("../lib/musicModels");

const DAYS = 90;
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 10 * 60 * 1000;
const FIELDS = { channelId: 1, why: 1, outcome: 1, live: 1, hour: 1, endedAt: 1 };

let running = null;

function learn(events) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { events: events.map(({ _id, ...e }) => e), now: Date.now() } });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`worker ended with ${code}`)));
  });
}

async function run() {
  const events = await musicEventsRepo.since(null, DAYS, FIELDS);
  const byChannel = new Map();
  for (const e of events) {
    if (!byChannel.has(e.channelId)) byChannel.set(e.channelId, []);
    byChannel.get(e.channelId).push(e);
  }
  await musicModelRepo.save("all", await learn(events));
  for (const [channelId, own] of byChannel) if (own.length >= ROWS_MIN && byChannel.size > 1) await musicModelRepo.save(channelId, await learn(own));
  models.set(await musicModelRepo.loadAll());
}

function runOnce() {
  running = running || run().catch((err) => console.error("[musicRankTrain] failed:", err.message)).finally(() => { running = null; });
  return running;
}

async function startMusicRankTrain() {
  try {
    models.set(await musicModelRepo.loadAll());
  } catch (err) {
    console.error("[musicRankTrain] could not load the models:", err.message);
  }
  setTimeout(function again() {
    runOnce().then(() => setTimeout(again, RUN_EVERY_MS).unref());
  }, BOOT_DELAY_MS).unref();
}

module.exports = { startMusicRankTrain, runOnce };
