// What the command editor and the variables page show about variables: groups, descriptions,
// examples, and the exact text a pick from the list inserts. Site-only - the grammar and the list
// of built-in NAMES live in lib/variableTemplate.js (the bot's copy decides what they mean), the
// words about them live in config/locales/*.json under variableEditor.*.
//
// Pure: takes a translator and the channel's own variables, returns plain data that a view
// inlines through res.locals.safeJson (variable values and names are channel data, not markup).
const VT = require("./variableTemplate");

// Group order is the order of the "# Variable" list.
const GROUPS = ["own", "viewer", "stream", "random", "args"];

const BUILTIN_GROUP = {
  username: "viewer",
  touser: "viewer",
  channel: "stream",
  game: "stream",
  time: "stream",
  date: "stream",
  rand: "random",
  pick: "random",
  args: "args",
};
for (let i = 1; i <= 9; i++) BUILTIN_GROUP[`argument${i}`] = "args";

// Display order inside the groups.
const BUILTIN_ORDER = [
  "username", "touser",
  "channel", "game", "time", "date",
  "rand", "pick",
  "argument1", "argument2", "argument3", "argument4", "argument5", "argument6", "argument7", "argument8", "argument9", "args",
];

// A parametric built-in is inserted with its example parameters selected, so typing replaces
// them straight away. `select` is the [start, end) of that selection inside `insert`.
function snippetFor(name, t) {
  if (name === "rand") return { insert: "#rand(1-100)", select: [6, 11] };
  if (name === "pick") {
    const options = t("variableEditor.pickSnippet");
    return { insert: `#pick(${options})`, select: [6, 6 + options.length] };
  }
  return { insert: `#${name}`, select: null };
}

function describeBuiltin(name, t) {
  const arg = name.match(/^argument([1-9])$/);
  if (arg) {
    return {
      desc: t("variableEditor.builtin.argumentN.desc", { n: arg[1] }),
      example: t("variableEditor.builtin.argumentN.example", { n: arg[1] }),
    };
  }
  return {
    desc: t(`variableEditor.builtin.${name}.desc`),
    example: t(`variableEditor.builtin.${name}.example`),
  };
}

// Sample values for the editor's preview line ("Пример: Вася обнимает Петю"). Time and date are
// filled in by the browser from its own clock, #rand and #pick roll in the browser too.
function previewSamples(t, channelLogin) {
  const words = t("variableEditor.sample.args").split(" ");
  const samples = {
    username: t("variableEditor.sample.username"),
    touser: t("variableEditor.sample.touser"),
    channel: channelLogin,
    game: t("variableEditor.sample.game"),
    args: words.join(" "),
  };
  for (let i = 1; i <= 9; i++) samples[`argument${i}`] = words[i - 1] || "";
  return samples;
}

// The editor's own words. Placeholders like {{raw}} are left in - the browser fills them.
const STRING_KEYS = [
  "insertButton", "insertButtonTitle", "listLabel", "noMatches", "escHint", "chipEdit", "chipRemove",
  "chipLiteral", "overrides", "preview", "previewEmpty", "timerWarning", "length", "tooLong", "exampleLabel",
];
const INVALID_REASONS = ["user_params", "no_params", "fallback_too_long", "range", "pick", "unknown_grammar"];

function editorStrings(t) {
  const strings = {};
  for (const key of STRING_KEYS) strings[key] = t(`variableEditor.${key}`);
  strings.invalid = {};
  for (const reason of INVALID_REASONS) strings.invalid[reason] = t(`variableEditor.invalid.${reason}`);
  return strings;
}

// ownVariables: [{name, value}] as variablesRepo.list maps them.
function buildVariableCatalog(t, { ownVariables = [], channelLogin = "" } = {}) {
  const items = [];
  for (const v of ownVariables) {
    items.push({
      name: v.name,
      group: "own",
      own: true,
      value: v.value,
      overridesBuiltin: VT.isBuiltin(v.name),
      insert: `#${v.name}`,
      select: null,
      desc: t("variableEditor.ownValue", { value: v.value }),
      example: "",
    });
  }
  const ownNames = new Set(ownVariables.map((v) => v.name));
  for (const name of BUILTIN_ORDER) {
    if (ownNames.has(name)) continue; // the channel's own variable is what this name means here
    const spec = VT.BUILTINS[name];
    items.push({
      name,
      group: BUILTIN_GROUP[name],
      own: false,
      perCaller: !!spec.perCaller,
      params: spec.params,
      ...snippetFor(name, t),
      ...describeBuiltin(name, t),
    });
  }
  return {
    groups: GROUPS.map((key) => ({ key, label: t(`variableEditor.group.${key}`) })),
    items,
    samples: previewSamples(t, channelLogin),
    strings: editorStrings(t),
  };
}

module.exports = { buildVariableCatalog, BUILTIN_ORDER, BUILTIN_GROUP, GROUPS, INVALID_REASONS };
