// Twitch login <-> numeric user ID resolution via Helix "Get Users", using an
// app access token (client_credentials). Mirrors TwitchBot/twitch/userLookup.js,
// reimplemented here since the two repos share no code.
const axios = require("axios");
const env = require("../config/env");
const { ensureAppAccessToken } = require("./appToken");

const USERS_URL = "https://api.twitch.tv/helix/users";
const MAX_PER_REQUEST = 100;

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function fetchUsers(paramName, values) {
  if (!values.length) return [];
  const headers = {
    Authorization: `Bearer ${await ensureAppAccessToken()}`,
    "Client-Id": env.twitchClientId,
  };
  const results = [];
  for (const batch of chunk(values, MAX_PER_REQUEST)) {
    const params = new URLSearchParams();
    for (const value of batch) params.append(paramName, value);
    const response = await axios.get(`${USERS_URL}?${params.toString()}`, { headers });
    results.push(...response.data.data);
  }
  return results;
}

async function getUsersByLogin(logins) {
  const normalized = logins.map((login) => login.trim().toLowerCase()).filter(Boolean);
  return fetchUsers("login", normalized);
}

async function getUsersById(ids) {
  const normalized = ids.map((id) => `${id}`.trim()).filter(Boolean);
  return fetchUsers("id", normalized);
}

module.exports = { getUsersByLogin, getUsersById };
