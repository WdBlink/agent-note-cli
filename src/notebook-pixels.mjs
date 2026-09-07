// Draw the closed one-ink mark first: leather outline, separated page edge, elastic knot.
// c/s/i become paper in the one-ink design; the elastic remains an unbroken ink stroke.
const palette = { d: 94, c: 137, h: 180, p: 230, e: 187, g: 65, b: 180, k: 237, s: 95, i: 144, t: 230, n: 237, z: 137, f: 180, u: 137 };
const closed = [
  '',
  '...hhhhhhhhh',
  '..htttttttte',
  '.ddhhhhhhhde',
  '.ddcccccccdp',
  '.ddcccccccdsp',
  '.ddcccccccdsp',
  '.ddcccccccdsp',
  '.ddcccccccdsp',
  '.ddccccbccdsp',
  '.ddkkkbsbkdsp',
  '.ddccccbccdsp',
  '.ddcccccccdsp',
  '.ddcccccccdsp',
  '.ddcccccccdsp',
  '.ddcccccccdsp',
  '.ddcccccccdsp',
  '.ddcccccccdsp',
  '.ddcccccccdsp',
  '.ddcccccccdsp',
  '.ddhhhhhhhdee',
  '..dddddddded',
  '.g',
  '..g',
];
const released = closed.map((row, y) => y >= 9 && y <= 11 ? '.ddcccccccdsp' : row);
released[12] = '.ddkkkkcccdsp';
released[13] = '.ddcccckkbdsp';
const ajar = [
  '',
  '..........hh.hhhhhhhhh',
  '.........hcspppppppppd',
  '........hccspppppppppd',
  '.......hcccspppppppppd',
  '......dccccspppppppppd',
  '......dccccspppppppppd',
  '......dccccspppppppppd',
  '......dccccspppppppppd',
  '......dccccspppppppppd',
  '......dccccspppppppppd',
  '......dccccspppppppppd',
  '......dccccspppppppppd',
  '......dccccspppppppppd',
  '......dccccspppppppppd',
  '......dccccspppppppppd',
  '......dccccspppppppppd',
  '......dccccspppppppppd',
  '.......dcccspppppppppd',
  '........dccspppppppppd',
  '.........dcspppppppppd',
  '..........dhhhhhhhhhd',
  '...........g',
  '............g',
];
const opened = [
  '',
  '.dhhhhhhhhd.dhhhhhhhhd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.dpppppppppspppppppppd',
  '.deeeeeeeeeseeeeeeeeed',
  '..hhhhhhhhdhhhhhhhhhd',
  '...........g',
  '............g',
];
// All frames share a binding at column 11 and the same bookmark pixels.
const sprites = [closed, released, ajar, opened].map((rows, n) => rows.map(row => ('.'.repeat(n < 2 ? 10 : 0) + row).padEnd(26, '.')));
const names = ['皮套与绳结', '松开弹力绳', '翻开皮套', '展开内芯'];
const writingStart = sprites.length;
const writingSequence = [];

function writingFrame(completed, nibX, nibY) {
  const pixels = sprites[3].map(row => [...row]);
  for (let line = 0; line < 3; line++) {
    const y = 7 + line * 4;
    for (let x = 4; x < (line === 2 ? 7 : 9); x++) pixels[y][x] = 'i';
    for (let column = 0; column < 5 && line * 5 + column < completed; column++) pixels[y][14 + column] = 'i';
  }
  // A diagonal barrel, brass band and one-pixel nib; keep the pen visible off the page too.
  const put = (x, y, material = 'u') => {
    if (!pixels[y] || x >= pixels[y].length) return;
    pixels[y][x] = pixels[y][x] === '.' ? (material === 'f' ? 'h' : 'z') : material;
  };
  put(nibX, nibY, 'n');
  for (let step = 1; step <= 5; step++) {
    put(nibX + step, nibY - step, step === 2 ? 'f' : 'u');
    put(nibX + step + 1, nibY - step, step === 2 ? 'f' : 'u');
  }
  return pixels.map(row => row.join(''));
}

for (let line = 0; line < 3; line++) {
  for (let column = 0; column <= 5; column++) {
    sprites.push(writingFrame(line * 5 + column, 14 + column, 7 + line * 4));
    names.push('正在整理 · 落笔记录');
    writingSequence.push(sprites.length - 1);
  }
  sprites.push(writingFrame((line + 1) * 5, 19, 5 + line * 4));
  names.push(line === 2 ? '正在整理 · 抬笔回看' : '正在整理 · 抬笔换行');
  writingSequence.push(sprites.length - 1, sprites.length - 1);
}
// Start by opening once. The busy loop stays on the spread; it never closes the cover.
const intro = [0, 0, 0, 1, 1, 2, 2, 3, 3];
const loopStart = intro.length;
const timeline = [...intro, ...writingSequence];
function nextTick(tick, distinct = false) {
  let next = tick;
  do { next = next + 1 < timeline.length ? next + 1 : loopStart; }
  while (distinct && timeline[next] === timeline[tick]);
  return next;
}
const monoSprite = sprite => sprite.map(row => row.replace(/[csitnfu]/g, '.').replace(/[^.]/g, 'p'));
const reset = '\x1b[0m';
const bg = '\x1b[48;5;234m';

function cells(top, bottom) {
  return [...top].map((a, x) => {
    const b = bottom[x];
    return a === '.' && b === '.' ? { char: ' ' }
      : a === '.' ? { char: '▄', fg: b }
        : b === '.' ? { char: '▀', fg: a }
          : a === b ? { char: '█', fg: a }
            : { char: '▀', fg: a, bg: b };
  });
}

function render(sprite, color = true, backdrop = bg) {
  if (!color) sprite = monoSprite(sprite);
  return Array.from({ length: sprite.length / 2 }, (_, y) => cells(sprite[y * 2], sprite[y * 2 + 1]).map(cell => {
    if (!color) return cell.char;
    return `${reset}${backdrop}${cell.fg ? `\x1b[38;5;${palette[cell.fg]}m` : ''}${cell.bg ? `\x1b[48;5;${palette[cell.bg]}m` : ''}${cell.char}`;
  }).join('') + (color ? reset + backdrop : ''));
}

// Native-image callers use the matching assets; these rows are the text fallback only.
export function renderNotebook(asset, color, backdrop, writingElapsed) {
  const pose = { notebook: 0, 'notebook-strap-lift': 1, 'notebook-strap-free': 1, 'notebook-ajar': 2, 'notebook-open': 3 }[asset] ?? 0;
  const sprite = asset === 'mark' ? ['.hhp', 'dccp', 'dkkp', '.ddg']
    : asset === 'notebook-open' && writingElapsed !== undefined
      ? sprites[writingSequence[Math.floor(Math.max(0, writingElapsed) / 180) % writingSequence.length]]
      : sprites[pose];
  return render(sprite, color, backdrop);
}

export { palette, sprites, names, writingStart, writingSequence, timeline, loopStart, nextTick, monoSprite, cells, render };
