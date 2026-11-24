// Web-only: MusicGraphSettings, one document - the switches of lib/musicFeatures.js:
//   { _id: "features", modes: { tags, model, similar, start }, updatedAt, updatedBy }
const { connectWeb } = require("./connection");

const collection = async () => (await connectWeb()).collection("MusicGraphSettings");

async function load() {
  const doc = await (await collection()).findOne({ _id: "features" });
  return (doc && doc.modes) || null;
}

async function save(modes, updatedBy) {
  await (await collection()).updateOne({ _id: "features" }, { $set: { modes, updatedAt: new Date(), updatedBy } }, { upsert: true });
}

module.exports = { load, save };
