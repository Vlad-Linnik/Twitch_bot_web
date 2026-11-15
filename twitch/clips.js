// Helix "Get Clips" for a time window - the year recap's loud moments are shown with a clip a
// viewer made of them (jobs/annualRecap.js). Clips are public: the app access token is enough,
// no scope on the channel, which is the whole reason the recap looks for viewers' clips instead
// of having the bot create its own.
//
// started_at/ended_at filter on the clip's created_at. One window is a few minutes, so a single
// page of 100 is all of it on any channel this site serves.
const axios = require("axios");
const env = require("../config/env");
const { ensureAppAccessToken } = require("./appToken");

const CLIPS_URL = "https://api.twitch.tv/helix/clips";

async function clipsInWindow(broadcasterId, from, to) {
  const response = await axios.get(CLIPS_URL, {
    params: {
      broadcaster_id: String(broadcasterId),
      started_at: new Date(from).toISOString(),
      ended_at: new Date(to).toISOString(),
      first: 100,
    },
    headers: {
      Authorization: `Bearer ${await ensureAppAccessToken()}`,
      "Client-Id": env.twitchClientId,
    },
  });
  return response.data?.data ?? [];
}

// Map<videoId, Date> - when each VOD (i.e. its stream) started. A clip's `vod_offset` counts from
// there, which is the only way to know WHAT a clip shows rather than when it was made.
async function videoStarts(videoIds) {
  const ids = [...new Set(videoIds.filter(Boolean).map(String))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const params = new URLSearchParams();
    for (const id of ids.slice(i, i + 100)) params.append("id", id);
    const response = await axios.get(`https://api.twitch.tv/helix/videos?${params}`, {
      headers: {
        Authorization: `Bearer ${await ensureAppAccessToken()}`,
        "Client-Id": env.twitchClientId,
      },
      // A VOD that expired answers 404 for the whole batch; that is "no start known", not a fault.
      validateStatus: (s) => s === 200 || s === 404,
    });
    for (const v of response.data?.data ?? []) out.set(String(v.id), new Date(v.created_at));
  }
  return out;
}

module.exports = { clipsInWindow, videoStarts };
