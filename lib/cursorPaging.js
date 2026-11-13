// Keyset ("cursor") pagination for feeds that load more on scroll.
//
// Why not skip/limit: an offset counts from the top of the list, so a post published between
// two loads shifts every later item down by one and the next portion starts with a card the
// reader has already seen. A cursor names the last item shown - its sort value plus its _id -
// and the next portion is "everything strictly after that item", which an insert above it
// cannot move.
//
// The cursor is opaque to the client: base64url(JSON). Nothing in it is trusted - it is decoded
// back through the same spec that produced it, and anything that does not fit (wrong sort, bad
// date, bad id, not JSON at all) is reported as invalid so the route can answer 400 instead of
// handing a garbage value to Mongo.
//
// A spec describes one sort order:
//   { name: 'newest', key: 'createdAt', type: 'date' | 'number', direction: -1 | 1 }
// `name` is written into the cursor so a cursor minted for one sort is rejected by another
// (a rating value replayed against a date sort would silently page from the wrong place).
const { ObjectId } = require("mongodb");

// A real cursor is well under 150 characters; the ceiling only stops a pasted megabyte from
// being base64-decoded and JSON-parsed on every request.
const MAX_CURSOR_LENGTH = 512;

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function encodeValue(spec, value) {
  if (spec.type === "date") {
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (!Number.isFinite(time)) throw new TypeError(`cursorPaging: ${spec.key} is not a date`);
    return time;
  }
  if (spec.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`cursorPaging: ${spec.key} is not a finite number`);
    }
    return value;
  }
  throw new TypeError(`cursorPaging: unknown type ${spec.type}`);
}

function decodeValue(spec, raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  if (spec.type === "date") {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (spec.type === "number") return raw;
  return undefined;
}

// Builds the cursor that points AT `doc` - "continue after this one". Throws on a doc that lacks
// the sort key: that is a programming error on our side (a sort over a field the documents do
// not have), not bad input.
function encodeCursor(spec, doc) {
  if (!doc || !doc._id) throw new TypeError("cursorPaging: document has no _id");
  const payload = { s: spec.name, v: encodeValue(spec, doc[spec.key]), id: String(doc._id) };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

// Returns one of:
//   { cursor: null }                   - nothing supplied: first portion
//   { cursor: { value, id } }          - a valid cursor
//   { error: 'invalid_cursor' }        - supplied but unusable (forged, truncated, other sort)
// An array (`?cursor=a&cursor=b`) is invalid rather than "take the first": the client never
// sends that, so it only ever comes from a hand-edited URL.
function parseCursor(spec, raw) {
  if (raw === undefined || raw === null || raw === "") return { cursor: null };
  const invalid = { error: "invalid_cursor" };
  if (typeof raw !== "string" || raw.length > MAX_CURSOR_LENGTH || !BASE64URL.test(raw)) return invalid;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return invalid;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalid;
  if (payload.s !== spec.name) return invalid;
  if (typeof payload.id !== "string" || !OBJECT_ID_HEX.test(payload.id)) return invalid;

  const value = decodeValue(spec, payload.v);
  if (value === undefined) return invalid;

  return { cursor: { value, id: new ObjectId(payload.id) } };
}

// The sort that the cursor filter assumes. _id breaks ties between equal sort values, so two
// posts created in the same millisecond still have a single, stable order.
function sortFor(spec) {
  return { [spec.key]: spec.direction, _id: spec.direction };
}

// Items strictly AFTER the cursor in sort order:
//   key past v, or key equal to v and _id past id.
function buildAfterFilter(spec, cursor) {
  if (!cursor) return {};
  const past = spec.direction < 0 ? "$lt" : "$gt";
  return {
    $or: [{ [spec.key]: { [past]: cursor.value } }, { [spec.key]: cursor.value, _id: { [past]: cursor.id } }],
  };
}

// Items from the start of the list up to AND INCLUDING the cursor's item - the "come back to
// where I was" query, which reloads everything the reader had already scrolled through.
function buildThroughFilter(spec, cursor) {
  const before = spec.direction < 0 ? "$gt" : "$lt";
  const beforeOrSame = spec.direction < 0 ? "$gte" : "$lte";
  return {
    $or: [{ [spec.key]: { [before]: cursor.value } }, { [spec.key]: cursor.value, _id: { [beforeOrSame]: cursor.id } }],
  };
}

// Combines a base filter (the channel, a status) with a cursor clause without letting either
// overwrite the other's keys - both may legitimately constrain the same field.
function andFilters(base, extra) {
  if (!extra || Object.keys(extra).length === 0) return base;
  if (!base || Object.keys(base).length === 0) return extra;
  return { $and: [base, extra] };
}

// Shapes one fetched portion. The caller asks Mongo for limit + 1 rows; the extra row only
// proves there is a next portion and is never shown.
function slicePortion(spec, rows, limit) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length > 0 ? encodeCursor(spec, items[items.length - 1]) : null;
  return { items, nextCursor };
}

module.exports = {
  MAX_CURSOR_LENGTH,
  encodeCursor,
  parseCursor,
  sortFor,
  buildAfterFilter,
  buildThroughFilter,
  andFilters,
  slicePortion,
};
