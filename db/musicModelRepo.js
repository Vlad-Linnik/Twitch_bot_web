// Web-only: MusicGraphModel, the learnt weights (lib/musicRank.js train()), one document per model:
//   { _id: "all" | channelId, ...what train() returned, at }
const { connectWeb } = require("./connection");

const collection = async () => (await connectWeb()).collection("MusicGraphModel");

async function loadAll() {
  return (await collection()).find({}).toArray();
}

async function save(id, model) {
  await (await collection()).replaceOne({ _id: id }, { ...model, at: new Date() }, { upsert: true });
}

module.exports = { loadAll, save };
