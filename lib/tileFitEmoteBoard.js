// Turns an emote picture into a "Укладка" board: the picture shrunk into a 10 x 10 grid, every
// cell that is mostly opaque becomes a board cell, and the cell's colour paints the piece that
// covers it. Pure (takes raw RGBA pixels), so the rules are testable without an image library;
// routes/tileFit.js does the fetching and the resizing with sharp.
const SIDE = 10;
const MIN_ALPHA = 128;
const MIN_AREA = 20; // anything smaller is a line or a dot, not a picture to assemble

const hex = (v) => v.toString(16).padStart(2, "0");

// rgba: Uint8Array/Buffer of width*height*4. Returns {mask, colors} or null when the emote does not
// make a board (too thin, too small). Only the largest connected blob is kept - a board has to be
// one piece of land.
function boardFromPixels(rgba, width, height) {
  const solid = [];
  for (let r = 0; r < height; r++) {
    const row = [];
    for (let c = 0; c < width; c++) row.push(rgba[(r * width + c) * 4 + 3] >= MIN_ALPHA ? 1 : 0);
    solid.push(row);
  }
  const seen = solid.map((row) => row.map(() => false));
  let best = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!solid[r][c] || seen[r][c]) continue;
      const blob = [];
      const stack = [[r, c]];
      seen[r][c] = true;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        blob.push([cr, cc]);
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr >= 0 && nr < height && nc >= 0 && nc < width && solid[nr][nc] && !seen[nr][nc]) {
            seen[nr][nc] = true;
            stack.push([nr, nc]);
          }
        }
      }
      if (blob.length > best.length) best = blob;
    }
  }
  if (best.length < MIN_AREA) return null;
  const minR = Math.min(...best.map(([r]) => r));
  const maxR = Math.max(...best.map(([r]) => r));
  const minC = Math.min(...best.map(([, c]) => c));
  const maxC = Math.max(...best.map(([, c]) => c));
  const mask = [];
  const colors = [];
  for (let r = minR; r <= maxR; r++) {
    mask.push(new Array(maxC - minC + 1).fill(0));
    colors.push(new Array(maxC - minC + 1).fill(null));
  }
  best.forEach(([r, c]) => {
    const i = (r * width + c) * 4;
    mask[r - minR][c - minC] = 1;
    colors[r - minR][c - minC] = "#" + hex(rgba[i]) + hex(rgba[i + 1]) + hex(rgba[i + 2]);
  });
  return { mask, colors };
}

module.exports = { boardFromPixels, SIDE, MIN_AREA };
