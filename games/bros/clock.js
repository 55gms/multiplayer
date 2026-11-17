// One 60 Hz clock for every bros match. The games run one simulation step per
// tick message while online, so the tick rate is the game speed: the original
// servers send one every 16.67 ms. Node's setInterval would round to 16 ms
// (4% fast), so each wait is aimed at the next frame's exact time instead.

const FRAME_MS = 1000 / 60;
// After a stall (GC, a busy event loop) catch up a few frames, not seconds' worth.
const MAX_CATCH_UP = 4;

const matches = new Set();
let timer = null;
let start = 0;
let frame = 0;

function run() {
  timer = null;
  if (!matches.size) return;
  const due = Math.floor((performance.now() - start) / FRAME_MS);
  if (due - frame > MAX_CATCH_UP) frame = due - MAX_CATCH_UP;
  while (frame < due) {
    frame++;
    for (const match of matches) match.tick();
  }
  schedule();
}

function schedule() {
  const wait = start + (frame + 1) * FRAME_MS - performance.now();
  timer = setTimeout(run, Math.max(0, wait));
}

export function startTicking(match) {
  matches.add(match);
  if (timer) return;
  start = performance.now();
  frame = 0;
  schedule();
}

export function stopTicking(match) {
  matches.delete(match);
  if (!matches.size && timer) {
    clearTimeout(timer);
    timer = null;
  }
}
