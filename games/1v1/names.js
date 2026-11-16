// Player names. 1v1.lol got a guest's name from its own (now dead) login
// service, so it joins rooms with an empty name. The 55GMS page passes the
// name the player chose as ?name= on each connection; it is sent back in
// Authenticate (PUN takes it as its NickName) and filled into the player's
// properties whenever the game leaves it empty.
import { Hashtable, byte } from "../../src/photon/protocol18.js";
import { ActorProp } from "../../src/photon/codes.js";

const MAX = 16;
// Control characters, zero-width and direction marks, and angle brackets.
const UNWANTED = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f<>]", "g");

export function playerName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFKC").replace(UNWANTED, "").replace(/\s+/g, " ").trim().slice(0, MAX);
  return name || null;
}

// Puts `name` in a player-properties table if its PlayerName is missing or empty.
export function withName(props, name) {
  if (!name || !(props instanceof Hashtable)) return props;
  const key = byte(ActorProp.PlayerName);
  const current = props.get(key);
  if (typeof current !== "string" || current === "") props.set(key, name);
  return props;
}
