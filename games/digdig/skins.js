// The client's skin shop (client build 2749f7ba, read from its memory): every
// skin's id, slot, price in gold and index. The client sends skins by index
// (message 20: [face, spinner], 0 for none) and buys them by id (message 2);
// diggers wear them as component 10 field 68, [face, spinner].
//
// Indexes count from 1 within a slot, in the order of the ids. spider has no
// price: the shop does not sell it.
export const FACE = 0;
export const SPINNER = 1;

const TABLE = [
  // faces
  ["8ball", FACE, 10000],
  ["allseeing", FACE, 10000],
  ["creepy", FACE, 1000],
  ["cute", FACE, 7500],
  ["cyclops", FACE, 2500],
  ["dizzy", FACE, 10000],
  ["faceless", FACE, 10000],
  ["florrio", FACE, 500],
  ["intellectual", FACE, 1500],
  ["kirk", FACE, 500],
  ["kirkier", FACE, 2000],
  ["moyai", FACE, 4000],
  ["pixels", FACE, 2000],
  ["sarcastic", FACE, 5000],
  ["spider", FACE, null],
  ["toocool", FACE, 1500],
  // spinners
  ["blob", SPINNER, 5000],
  ["fast", SPINNER, 500],
  ["gear", SPINNER, 2500],
  ["landmine", SPINNER, 1500],
  ["naked", SPINNER, 1500],
  ["omniring", SPINNER, 5000],
  ["smasher", SPINNER, 500],
  ["spike", SPINNER, 1000],
  ["tentacles", SPINNER, 10000],
  ["tracker", SPINNER, 5000],
  ["wobbly", SPINNER, 2000],
  ["wrong_way", SPINNER, 250],
];

export const SKINS = new Map();
const bySlot = [[], []];
for (const [id, slot, price] of TABLE) {
  const skin = { id, slot, price, index: bySlot[slot].length + 1 };
  bySlot[slot].push(skin);
  SKINS.set(id, skin);
}

// the skin at an index of a slot, or null (0 is none)
export function skinAt(slot, index) {
  return bySlot[slot]?.[index - 1] || null;
}

// a random skin of a slot that the shop sells, for bots
export function randomSkin(slot) {
  const list = bySlot[slot].filter((s) => s.price);
  return list[Math.floor(Math.random() * list.length)];
}
