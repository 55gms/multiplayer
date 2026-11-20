// Squads: up to four players who play together. The client asks with
// messages 7 (a squad: opening the Squad panel; Find Public once in one),
// 9 (New) and 32 (Join, with a code), and toggles Public with message 17.
// The squad itself is an entity with component 9 (connection.js); server
// messages 18 and 27 only say why a request failed.
//
// A code is shown as "<server id>-<code>"; the server id is the mode, the
// part the client puts in front itself. Members share a lobby, cannot hurt
// each other, see what each other sees, and play on one team in TDM.
export const SQUAD_SIZE = 4;
// the modes whose servers allow squads (the client's server list: "squads": "4")
export const SQUAD_MODES = new Set(["ffa", "teams", "maze"]);

const squads = new Map(); // code -> Squad
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function newCode() {
  for (;;) {
    let code = "";
    for (let i = 0; i < 6; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!squads.has(code)) return code;
  }
}

export class Squad {
  constructor(mode, isPublic = false) {
    this.code = newCode();
    this.mode = mode;
    this.public = isPublic;
    this.members = [];
    squads.set(this.code, this);
  }

  get full() {
    return this.members.length >= SQUAD_SIZE;
  }

  add(conn) {
    if (conn.squad === this) return;
    leaveSquad(conn);
    this.members.push(conn);
    conn.squad = this;
    if (conn.digger) conn.digger.squad = this;
  }
}

export function leaveSquad(conn) {
  const squad = conn.squad;
  if (!squad) return;
  squad.members = squad.members.filter((c) => c !== conn);
  conn.squad = null;
  if (conn.digger) conn.digger.squad = null;
  if (!squad.members.length) squads.delete(squad.code);
}

export function findSquad(code, mode) {
  const squad = squads.get(String(code || "").toLowerCase());
  return squad && squad.mode === mode ? squad : null;
}

// a public squad of the mode with room, other than the one given
export function publicSquad(mode, except) {
  for (const squad of squads.values()) {
    if (squad !== except && squad.public && squad.mode === mode && !squad.full) return squad;
  }
  return null;
}
