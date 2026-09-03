// The on-site games catalog (id, url, i18n keys, decorative preview SVG) -
// the single source of truth for both the /games hub (routes/games.js) and
// the admin panel's per-game visibility/category controls (routes/admin.js,
// db/gameCatalogRepo.js). `id` is the catalog/admin identifier; note Durak's
// GameScores leaderboard key is "durak-multiplayer" (see routes/games.js),
// not "durak" - the two are intentionally decoupled since this catalog is
// about the /games hub card, not score storage.
module.exports = [
  {
    id: "falling-blocks",
    url: "/games/falling-blocks",
    nameKey: "games.fallingBlocks.name",
    descKey: "games.fallingBlocks.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <g>
          <rect x="66" y="6" width="16" height="16" rx="2" fill="#c084fc"/>
          <rect x="66" y="24" width="16" height="16" rx="2" fill="#c084fc"/>
          <rect x="84" y="24" width="16" height="16" rx="2" fill="#c084fc"/>
          <rect x="84" y="6" width="16" height="16" rx="2" fill="#c084fc" opacity="0.35"/>
        </g>
        <rect x="12" y="68" width="16" height="16" rx="2" fill="#38bdf8"/>
        <rect x="30" y="68" width="16" height="16" rx="2" fill="#38bdf8"/>
        <rect x="30" y="50" width="16" height="16" rx="2" fill="#38bdf8"/>
        <rect x="48" y="68" width="16" height="16" rx="2" fill="#fbbf24"/>
        <rect x="66" y="68" width="16" height="16" rx="2" fill="#fbbf24"/>
        <rect x="66" y="50" width="16" height="16" rx="2" fill="#34d399"/>
        <rect x="84" y="68" width="16" height="16" rx="2" fill="#fb7185"/>
        <rect x="102" y="68" width="16" height="16" rx="2" fill="#fb7185"/>
        <rect x="102" y="50" width="16" height="16" rx="2" fill="#818cf8"/>
        <rect x="120" y="68" width="16" height="16" rx="2" fill="#fb923c"/>
      </svg>`,
  },
  {
    id: "pipe-dodger",
    url: "/games/pipe-dodger",
    nameKey: "games.pipeDodger.name",
    descKey: "games.pipeDodger.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <rect x="30" y="0" width="18" height="30" rx="2" fill="#38bdf8"/>
        <rect x="26" y="26" width="26" height="8" rx="2" fill="#0f7ea8"/>
        <rect x="30" y="60" width="18" height="30" rx="2" fill="#38bdf8"/>
        <rect x="26" y="56" width="26" height="8" rx="2" fill="#0f7ea8"/>
        <rect x="102" y="0" width="18" height="16" rx="2" fill="#38bdf8"/>
        <rect x="98" y="12" width="26" height="8" rx="2" fill="#0f7ea8"/>
        <rect x="102" y="48" width="18" height="42" rx="2" fill="#38bdf8"/>
        <rect x="98" y="44" width="26" height="8" rx="2" fill="#0f7ea8"/>
        <g transform="translate(75,44) rotate(-12)">
          <rect x="-11" y="-9" width="22" height="18" rx="6" fill="#38bdf8"/>
          <circle cx="4" cy="-2" r="1.6" fill="#0b0b0b"/>
        </g>
      </svg>`,
  },
  {
    id: "2048",
    url: "/games/2048",
    nameKey: "games.2048.name",
    descKey: "games.2048.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <rect x="35" y="5" width="80" height="80" rx="4" fill="#262626"/>
        <rect x="41" y="11" width="32" height="32" rx="3" fill="#e5e5e5"/>
        <rect x="77" y="11" width="32" height="32" rx="3" fill="#38bdf8"/>
        <rect x="41" y="47" width="32" height="32" rx="3" fill="#a855f7"/>
        <rect x="77" y="47" width="32" height="32" rx="3" fill="#fbbf24"/>
      </svg>`,
  },
  {
    id: "durak",
    url: "/games/durak",
    nameKey: "games.durak.name",
    descKey: "games.durak.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <g transform="translate(75,48) rotate(-14)">
          <rect x="-19" y="-27" width="38" height="54" rx="4" fill="#e5e5e5" stroke="#171717" stroke-width="1"/>
          <text x="-13" y="-14" font-size="12" font-family="sans-serif" fill="#dc2626">K</text>
          <text x="-13" y="-2" font-size="12" font-family="sans-serif" fill="#dc2626">♥</text>
        </g>
        <g transform="translate(75,48) rotate(14)">
          <rect x="-19" y="-27" width="38" height="54" rx="4" fill="#fafafa" stroke="#171717" stroke-width="1"/>
          <text x="7" y="20" font-size="12" font-family="sans-serif" fill="#171717" transform="rotate(180)">A</text>
          <text x="7" y="8" font-size="12" font-family="sans-serif" fill="#171717" transform="rotate(180)">♠</text>
        </g>
      </svg>`,
  },
  {
    id: "minesweeper",
    url: "/games/minesweeper",
    nameKey: "games.minesweeper.name",
    descKey: "games.minesweeper.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <g fill="#404040">
          <rect x="35" y="5" width="20" height="20"/>
          <rect x="57" y="5" width="20" height="20"/>
          <rect x="35" y="27" width="20" height="20"/>
          <rect x="35" y="49" width="20" height="20"/>
        </g>
        <g fill="#171717">
          <rect x="79" y="5" width="20" height="20"/>
          <rect x="101" y="5" width="20" height="20"/>
          <rect x="57" y="27" width="20" height="20"/>
          <rect x="79" y="27" width="20" height="20"/>
          <rect x="101" y="27" width="20" height="20"/>
          <rect x="57" y="49" width="20" height="20"/>
          <rect x="79" y="49" width="20" height="20"/>
          <rect x="101" y="49" width="20" height="20"/>
        </g>
        <text x="63" y="42" font-size="14" font-weight="700" font-family="sans-serif" fill="#38bdf8">1</text>
        <text x="85" y="42" font-size="14" font-weight="700" font-family="sans-serif" fill="#34d399">2</text>
        <text x="63" y="64" font-size="14" font-weight="700" font-family="sans-serif" fill="#38bdf8">1</text>
        <circle cx="111" cy="59" r="6" fill="#fb7185"/>
      </svg>`,
  },
  {
    id: "match-3",
    url: "/games/match-3",
    nameKey: "games.match3.name",
    descKey: "games.match3.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <rect x="35" y="30" width="18" height="18" rx="4" fill="#fb7185"/>
        <rect x="55" y="30" width="18" height="18" rx="4" fill="#fb7185"/>
        <rect x="75" y="30" width="18" height="18" rx="4" fill="#fb7185"/>
        <rect x="95" y="10" width="18" height="18" rx="4" fill="#38bdf8"/>
        <rect x="95" y="30" width="18" height="18" rx="4" fill="#fbbf24"/>
        <rect x="95" y="50" width="18" height="18" rx="4" fill="#34d399"/>
        <rect x="35" y="52" width="18" height="18" rx="4" fill="#a855f7"/>
        <rect x="55" y="10" width="18" height="18" rx="4" fill="#34d399"/>
      </svg>`,
  },
  {
    id: "cloud-climber",
    url: "/games/cloud-climber",
    nameKey: "games.cloudClimber.name",
    descKey: "games.cloudClimber.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <rect x="18" y="66" width="34" height="9" rx="4" fill="#4ade80"/>
        <rect x="100" y="30" width="34" height="9" rx="4" fill="#fbbf24"/>
        <path d="M108 30 l3 -4 l3 4 l3 -4 l3 4 l3 -4 l3 4" fill="none" stroke="#a16207" stroke-width="2" stroke-linecap="round"/>
        <rect x="60" y="18" width="34" height="9" rx="4" fill="#38bdf8"/>
        <circle cx="75" cy="52" r="12" fill="#22c55e"/>
        <circle cx="70" cy="49" r="2.4" fill="#fff"/>
        <circle cx="80" cy="49" r="2.4" fill="#fff"/>
        <circle cx="70.5" cy="49.5" r="1.1" fill="#171717"/>
        <circle cx="80.5" cy="49.5" r="1.1" fill="#171717"/>
      </svg>`,
  },
  {
    id: "battleship",
    url: "/games/battleship",
    nameKey: "games.battleship.name",
    descKey: "games.battleship.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <rect x="20" y="10" width="110" height="70" fill="none" stroke="#404040" stroke-width="1"/>
        <rect x="42" y="32" width="66" height="16" rx="3" fill="#38bdf8" opacity="0.5"/>
        <circle cx="53" cy="21" r="5" fill="none" stroke="#a3a3a3" stroke-width="2"/>
        <circle cx="53" cy="21" r="1.5" fill="#a3a3a3"/>
        <rect x="86" y="54" width="11" height="11" fill="#fb7185"/>
        <rect x="97" y="54" width="11" height="11" fill="#be123c"/>
      </svg>`,
  },
  {
    id: "pong",
    url: "/games/pong",
    nameKey: "games.pong.name",
    descKey: "games.pong.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <line x1="75" y1="6" x2="75" y2="84" stroke="#404040" stroke-width="3" stroke-dasharray="6 6"/>
        <rect x="16" y="30" width="7" height="26" rx="2" fill="#c084fc"/>
        <rect x="127" y="40" width="7" height="26" rx="2" fill="#e5e5e5"/>
        <circle cx="90" cy="45" r="5" fill="#38bdf8"/>
      </svg>`,
  },
  {
    id: "connect-four",
    url: "/games/connect-four",
    nameKey: "games.connectFour.name",
    descKey: "games.connectFour.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <rect x="20" y="10" width="110" height="70" rx="6" fill="#0c4a6e"/>
        <circle cx="35" cy="60" r="10" fill="#c084fc"/>
        <circle cx="57" cy="60" r="10" fill="#c084fc"/>
        <circle cx="79" cy="60" r="10" fill="#c084fc"/>
        <circle cx="101" cy="60" r="10" fill="#c084fc"/>
        <circle cx="35" cy="38" r="10" fill="#171717"/>
        <circle cx="101" cy="38" r="10" fill="#fbbf24"/>
        <circle cx="79" cy="38" r="10" fill="#171717"/>
      </svg>`,
  },
  {
    id: "sunduchki",
    url: "/games/sunduchki",
    nameKey: "games.sunduchki.name",
    descKey: "games.sunduchki.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <rect x="18" y="42" width="46" height="34" rx="3" fill="#a16207" stroke="#171717" stroke-width="1"/>
        <rect x="18" y="42" width="46" height="12" fill="#ca8a04"/>
        <circle cx="41" cy="48" r="2.4" fill="#fde68a"/>
        <rect x="86" y="30" width="46" height="46" rx="3" fill="#b45309" stroke="#171717" stroke-width="1"/>
        <rect x="86" y="30" width="46" height="14" fill="#d97706"/>
        <circle cx="109" cy="37" r="2.6" fill="#fde68a"/>
        <g transform="translate(75,20) rotate(-10)">
          <rect x="-13" y="-18" width="26" height="36" rx="3" fill="#fafafa" stroke="#171717" stroke-width="1"/>
          <text x="-8" y="-4" font-size="11" font-family="sans-serif" fill="#dc2626">6</text>
          <text x="-8" y="8" font-size="11" font-family="sans-serif" fill="#dc2626">♦</text>
        </g>
      </svg>`,
  },
  {
    id: "higher-lower",
    url: "/games/higher-lower",
    nameKey: "games.higherLower.name",
    descKey: "games.higherLower.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <rect x="6" y="10" width="64" height="70" rx="4" fill="#1e1b4b"/>
        <rect x="80" y="10" width="64" height="70" rx="4" fill="#3b0764"/>
        <text x="38" y="40" font-size="13" font-family="sans-serif" font-weight="bold" fill="#e5e7eb" text-anchor="middle">чат</text>
        <text x="38" y="60" font-size="14" font-family="sans-serif" font-weight="bold" fill="#fde047" text-anchor="middle">22578</text>
        <text x="112" y="36" font-size="13" font-family="sans-serif" font-weight="bold" fill="#e5e7eb" text-anchor="middle">билд</text>
        <path d="M112 46 l7 8 h-14 z" fill="#4ade80"/>
        <path d="M112 72 l-7 -8 h14 z" fill="#f87171"/>
        <circle cx="75" cy="45" r="11" fill="#0a0a0a"/>
        <text x="75" y="49" font-size="9" font-family="sans-serif" font-weight="bold" fill="#a1a1aa" text-anchor="middle">vs</text>
      </svg>`,
  },
  {
    id: "unban-bureau",
    // Not a /games/* page: it's per-channel and tier-2 gated, so the card points at a picker
    // that forwards to /<channel>/unban-bureau (routes/unbanBureau.js). See requiresModerator.
    url: "/unban-bureau",
    nameKey: "games.unbanBureau.name",
    descKey: "games.unbanBureau.cardDescription",
    // The only catalog entry with this flag: /games is a public hub, but this card is useless
    // (and its target is a 403) for anyone who moderates no channel, so routes/games.js drops it
    // for those visitors. Admin hide/categorize still work on top, like every other game.
    requiresModerator: true,
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <rect x="26" y="14" width="62" height="66" rx="2" fill="#ece5d5" stroke="#171717" stroke-width="1"/>
        <rect x="34" y="22" width="18" height="18" rx="1" fill="#d6cdb8" stroke="#b91c1c" stroke-width="1" stroke-dasharray="2 2"/>
        <rect x="58" y="24" width="24" height="3" rx="1.5" fill="#78716c"/>
        <rect x="58" y="31" width="18" height="3" rx="1.5" fill="#a8a29e"/>
        <rect x="34" y="48" width="46" height="2.5" rx="1.25" fill="#a8a29e"/>
        <rect x="34" y="55" width="46" height="2.5" rx="1.25" fill="#a8a29e"/>
        <rect x="34" y="62" width="30" height="2.5" rx="1.25" fill="#a8a29e"/>
        <g transform="translate(104,46) rotate(-14)">
          <rect x="-26" y="-14" width="52" height="28" rx="2" fill="none" stroke="#15803d" stroke-width="3"/>
          <rect x="-21" y="-9" width="42" height="18" rx="1" fill="none" stroke="#15803d" stroke-width="1"/>
          <path d="M-10 0 l6 6 l12 -13" fill="none" stroke="#15803d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      </svg>`,
  },
  {
    id: "guess-chatter",
    url: "/games/guess-chatter",
    nameKey: "games.guessChatter.name",
    descKey: "games.guessChatter.cardDescription",
    preview: `
      <svg width="150" height="90" viewBox="0 0 150 90" aria-hidden="true">
        <path d="M22 10 h106 a4 4 0 0 1 4 4 v28 a4 4 0 0 1 -4 4 h-72 l-12 11 v-11 h-22 a4 4 0 0 1 -4 -4 v-28 a4 4 0 0 1 4 -4 z"
              fill="#262626" stroke="#404040" stroke-width="1"/>
        <rect x="32" y="20" width="60" height="4" rx="2" fill="#a3a3a3"/>
        <rect x="32" y="29" width="84" height="4" rx="2" fill="#737373"/>
        <circle cx="30" cy="76" r="11" fill="#3f3f46"/>
        <circle cx="60" cy="76" r="11" fill="#3f3f46"/>
        <circle cx="90" cy="76" r="11" fill="#7e22ce"/>
        <text x="90" y="81" text-anchor="middle" font-size="14" font-weight="bold" fill="#ffffff">?</text>
        <circle cx="120" cy="76" r="11" fill="#3f3f46"/>
      </svg>`,
  },
];
