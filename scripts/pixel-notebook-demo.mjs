// Run: node scripts/pixel-notebook-demo.mjs --color
// Preview: node scripts/pixel-notebook-demo.mjs --html > docs/assets/pixel-notebook-demo.html
import assert from 'node:assert/strict';
import { Terminal } from '../src/terminal.mjs';
import { palette, sprites, names, writingStart, timeline, loopStart, nextTick, cells, render } from '../src/notebook-pixels.mjs';

const reset = '\x1b[0m';
const bg = '\x1b[48;5;234m';
const plain = sprites[0].map((row, y) => y === 9 || y === 11 ? row.replace(/b/g, 'c') : y === 10 ? row.slice(0, 11) + 'ddkkkkkkkdsp' + row.slice(23) : row);
// Compare the old filled approach and two outline treatments at the same size.
const studies = [
  { name: '01 / 实心', sprite: sprites[0].map(row => row.replace(/[ck]/g, char => char === 'c' ? 'p' : 's')) },
  { name: '02 / 线框', sprite: plain },
  { name: '03 / 绳结 · 当前', sprite: sprites[0] },
];
function html() {
  const rgb = index => {
    if (index >= 232) return `rgb(${Array(3).fill(8 + (index - 232) * 10).join(',')})`;
    const n = index - 16, cube = [0, 95, 135, 175, 215, 255];
    return `rgb(${cube[Math.floor(n / 36)]},${cube[Math.floor(n / 6) % 6]},${cube[n % 6]})`;
  };
  const coloredFrame = sprite => Array.from({ length: sprite.length / 2 }, (_, y) => cells(sprite[y * 2], sprite[y * 2 + 1])
    .map(cell => `<span style="${cell.fg ? `color:${rgb(palette[cell.fg])};` : ''}${cell.bg ? `background:${rgb(palette[cell.bg])};` : ''}">${cell.char}</span>`).join('')).join('\n');
  const frames = sprites.map(coloredFrame);
  const monoStudies = studies.map(({ sprite }) => render(sprite.map(row => row.slice(9)), false).join('\n'));
  const monoFrames = sprites.map(sprite => render(sprite, false).join('\n'));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Note · 字符像素 Demo</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#121211;color:#dfd3bf;font:14px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;padding:44px 24px}main{max-width:900px;margin:auto}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}h1{font-size:18px;letter-spacing:.08em;font-weight:600;margin:0}small,.muted{color:#9e9689}.terminal{background:#1c1c1c;border:1px solid #39352e;border-radius:12px;overflow:hidden}.bar{padding:10px 20px;border-bottom:1px solid #39352e;color:#a69d8e;font:12px ui-monospace,monospace}.content{padding:30px 32px}.hero{display:flex;gap:48px;align-items:center;min-height:220px}pre{font-family:Menlo,Monaco,'DejaVu Sans Mono',monospace;font-size:16px;line-height:1;letter-spacing:0;font-weight:400;font-variant-ligatures:none;margin:0;white-space:pre;background:#1c1c1c}h2{font-size:20px;font-weight:500;margin:0 0 8px}.rule{border:0;border-top:1px solid #494033;margin:30px 0 24px}.studies{display:flex;justify-content:space-between;gap:12px}.study pre{font-size:13px}.study small{font-size:12px}.chosen small{color:#d7af87}.study small{display:block;margin-top:18px}.controls{display:flex;align-items:center;gap:10px;margin-top:28px}button{background:#292720;color:#dfd3bf;border:1px solid #514632;border-radius:6px;padding:7px 14px;font:inherit;cursor:pointer}button:hover{background:#393227}button:focus-visible{outline:2px solid #afaf87;outline-offset:3px}.detail{margin-top:20px;color:#aaa193;font-size:13px}.state{color:#afaf87;min-width:100px}code{font-size:12px;color:#cfc5b3}@media(max-width:680px){body{padding:24px 12px}.content{padding:22px 16px}.hero{gap:15px}.hero pre{font-size:13px}.studies{flex-wrap:wrap;gap:30px}.controls{flex-wrap:wrap}header small{display:none}}
</style><main><header><h1>AGENT NOTE</h1><small>字符回退预览 · TN</small></header><section class="terminal"><div class="bar">agent-note / character-fallback</div><div class="content"><div class="hero"><pre id="animated" aria-label="翻开笔记本并用笔整理笔记的动画">${monoFrames[0]}</pre><div><h2>正在整理笔记。</h2><div class="muted">把散落的思路，一笔一笔记下来。</div><p class="state" id="state">皮套与绳结</p></div></div><hr class="rule"><div class="studies">${studies.map(({ name }, n) => `<div class="study${n === 2 ? ' chosen' : ''}"><pre data-study="${n}" aria-label="${name}">${monoStudies[n]}</pre><small>${name}</small></div>`).join('')}</div><div class="controls"><button id="play" aria-pressed="false">暂停动画</button><button id="step">下一帧</button><button id="restart">重新演示</button><button id="mono" aria-pressed="true">查看彩色</button><small>翻开一次，持续书写。</small></div></div></section><p class="detail">实际 TUI 默认优先使用 PNG；此页仅预览图片不可用时的字符回退。翻开本子后，笔沿纸页移动，笔迹逐步出现，再抬笔换行。书写循环期间保持展开。上方保留三种单色轮廓对照。只用 █ ▀ ▄ 字符。 <a href="https://www.travelers-company.com/products/trnote/starter-kit-regular/brown" style="color:inherit">TN 外形参考</a>。</p><code>node scripts/pixel-notebook-demo.mjs --color</code></main>
<script>
const frames=${JSON.stringify(frames)},monoFrames=${JSON.stringify(monoFrames)},timeline=${JSON.stringify(timeline)},loopStart=${loopStart},names=${JSON.stringify(names)};
${nextTick.toString()}
let tick=0,mono=true,paused=matchMedia('(prefers-reduced-motion: reduce)').matches;
const play=document.getElementById('play'),sprite=document.getElementById('animated');
function draw(){const n=timeline[tick];sprite.innerHTML=mono?monoFrames[n]:frames[n];document.getElementById('state').textContent=names[n];play.textContent=paused?'播放动画':'暂停动画';play.setAttribute('aria-pressed',String(paused))}
play.onclick=()=>{paused=!paused;draw()};document.getElementById('step').onclick=()=>{paused=true;tick=nextTick(tick,true);draw()};
document.getElementById('restart').onclick=()=>{tick=0;paused=false;draw()};
document.getElementById('mono').onclick=event=>{mono=!mono;event.target.setAttribute('aria-pressed',String(mono));event.target.textContent=mono?'查看彩色':'切换单色';draw()};
setInterval(()=>{if(!paused){tick=nextTick(tick);draw()}},180);draw();
</script></html>`;
}

if (process.argv.includes('--check')) {
  for (const sprite of [...sprites, ...studies.map(study => study.sprite)]) {
    assert.equal(sprite.length, 24);
    assert(sprite.every(row => row.length === 26 && /^[.dchpegbksitnzfu]+$/.test(row)));
    assert(render(sprite, false).every(row => row.length === 26));
    assert(!/\x1b(?:\]|P|_)/.test(render(sprite).join('')), 'No image protocols');
  }
  assert.deepEqual(cells('.pgp', 'p.pg'), [{ char: '▄', fg: 'p' }, { char: '▀', fg: 'p' }, { char: '▀', fg: 'g', bg: 'p' }, { char: '▀', fg: 'p', bg: 'g' }]);
  assert.deepEqual(render(['hp', 'pg'], false), ['██'], 'Adjacent ink pixels remain filled regardless of their original colors');
  assert.deepEqual(render(['ci', 'sp'], false), [' ▄'], 'Leather, writing and gutter remain negative space');
  assert.deepEqual(render(['kb', 'dk'], false), ['██'], 'Elastic and knot stay connected in one ink');
  for (const sprite of sprites) assert.deepEqual(sprite.slice(22), sprites[0].slice(22), 'Bookmark must not drift between frames');
  assert(!html().includes('rgb(undefined'), 'Browser preview must render grayscale ANSI colors too');
  assert(html().includes('rgb(58,58,58)'), 'ANSI 237 elastic color must match the terminal');
  assert(timeline.every(n => sprites[n]));
  assert(timeline.slice(loopStart).every(n => n >= writingStart), 'Busy loop must never close or reopen the book');
  assert.equal(nextTick(timeline.length - 1), loopStart);
  assert.equal(sprites[writingStart + 3][7].slice(14, 17), 'iii', 'Ink must follow the nib');
  assert.notDeepEqual(sprites[writingStart], sprites[writingStart + 3], 'Pen must move');
  assert.deepEqual(render(['nz', 'pp'], false), ['▄█'], 'Pen must contrast with both paper and empty background');
  console.log('PASS: pixel grids, pen contrast, progressive ink, open-book loop, fixed bookmark, no image protocols');
} else if (process.argv.includes('--html')) {
  console.log(html());
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.log(render(sprites[4], false).join('\n'));
} else {
  const term = new Terminal({ color: process.argv.includes('--color') ? 'always' : 'auto' });
  term.graphics = null;
  let tick = 0, paused = false, mono = !term.color;
  const draw = () => {
    const n = timeline[tick];
    const rows = ['  AGENT NOTE / 字符像素 Demo', '', ...render(sprites[n], !mono).map(row => '  ' + row), '',
      '  ' + names[n], '', '  Space 暂停   → 下一帧   r 重播   m 单色   q 退出'];
    const text = term.columns < 54 || term.rows < 21 ? ['请将窗口放大到至少 54 × 21。', 'q 退出'] : rows;
    term.output.write('\x1b[H' + text.map(line => (mono ? reset : reset + bg + '\x1b[38;5;187m') + line + '\x1b[K').join('\r\n') + '\x1b[J');
  };
  let timer;
  term.start();
  try {
    term.output.on('resize', draw);
    draw();
    timer = setInterval(() => { if (!paused) { tick = nextTick(tick); draw(); } }, 180);
    while (!term.quit) {
      const key = await term.next();
      if (key.text === 'q' || key.name === 'escape') term.stop();
      if (key.name === 'space') paused = !paused;
      if (key.name === 'right') { paused = true; tick = nextTick(tick, true); }
      if (key.text === 'r') { tick = 0; paused = false; }
      if (key.text === 'm') mono = !mono;
      if (!term.quit) draw();
    }
  } finally {
    clearInterval(timer);
    term.output.off('resize', draw);
    term.close();
  }
}
