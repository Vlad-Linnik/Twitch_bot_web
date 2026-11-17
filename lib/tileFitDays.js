// Date numbers for the "Укладка" level of the day: YYYYMMDD as an integer, the form the level
// generator takes. Pure, so the day arithmetic the streak depends on can be tested.
function dayNumber(date) {
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

function fromDayNumber(n) {
  return new Date(Date.UTC(Math.floor(n / 10000), (Math.floor(n / 100) % 100) - 1, n % 100));
}

function previousDay(n) {
  return dayNumber(new Date(fromDayNumber(n).getTime() - 86400000));
}

// A player's "today" is their own calendar date, which can be a day either side of the server's
// UTC date; anything further away is not today's board for anyone.
function isAroundToday(n, now) {
  const today = dayNumber(now);
  return n === today || n === previousDay(today) || previousDay(n) === today;
}

module.exports = { dayNumber, fromDayNumber, previousDay, isAroundToday };
