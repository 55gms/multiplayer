// Achievements: the client's own list (build 2749f7ba, the table at memory
// 72248). Server message 22 [varint index] shows "Achievement unlocked" with
// the name, the text and the reward the client knows for that index; view
// field 43 (a sparse u8 list, one per achievement) is each one's progress,
// 0 to 100, which the client shows in its Achievements panel. 55GMS keeps
// what an account unlocked and its lifetime totals, and pays the rewards.
//
// Most are decided within one life; the ones with a stat and a goal count a
// lifetime total (the account's, plus the life being played).
import { TICK_MS, M } from "./world.js";
import { unlockAchievement, addStats } from "./accounts.js";

const sec = (s) => Math.round((s * 1000) / TICK_MS);
const ORES = [M.AMETHYST, M.GOLD, M.URANIUM, M.QUARTZ];
const ALL_ORES = ORES.reduce((m, o) => m | (1 << o), 0);
const oreCount = (mask) => ORES.filter((o) => mask & (1 << o)).length;
const mass = (d) => d.radius * d.radius;

// index = the client's achievement index; stat/goal: a lifetime total
export const ACHIEVEMENTS = [
  { id: "score_1" }, // Starting low: reach 10k score
  { id: "score_2" }, // Getting good: 100k
  { id: "score_3" }, // Got good: 1m
  { id: "one_of_many", stat: "kills", goal: 1 }, // destroy an enemy digger
  { id: "getting_better", stat: "kills", goal: 10 },
  { id: "killer", stat: "kills", goal: 100 },
  { id: "triple_kill" }, // 3 kills, each within 15 s of the one before
  { id: "genocide" }, // 5 of them
  { id: "pacifist" }, // no kills for 30 minutes
  { id: "david" }, // destroy an enemy 10x your size
  { id: "consolation_prize" }, // die to an enemy 1/10 your size
  { id: "excavator", stat: "dirt", goal: 1_000_000 }, // dig 1m dirt
  { id: "miner_not_digger" }, // 10k score without digging dirt
  { id: "how" }, // ... nor bedrock, uranium, nor destroying anyone
  { id: "gold_digger", stat: "gold", goal: 1000 }, // dig 1000 gold
  { id: "ouch" }, // dig lava
  { id: "mechanic_abuse" }, // dig 1k lava in one life
  { id: "collector", stat: "ores", goal: ORES.length }, // get all ores
  { id: "efficient_collector" }, // all ores in one life
  { id: "leader" }, // reach the top of the leaderboard
  { id: "supreme_leader" }, // stay on top for 30 minutes straight
  { id: "speedrun" }, // die within 5 s of spawning
  { id: "survivor" }, // survive 5 minutes
  { id: "willpower" }, // survive 60 minutes
  { id: "worth_it" }, // die within 5 s of collecting gold
  { id: "deflation" }, // 100k mass, then 10k mass, in one life
  { id: "hider" }, // win a Tag round as a hider
  { id: "seeker", stat: "tags", goal: 10 },
  { id: "efficient_seeker" }, // tag 5 in one life
  { id: "master_seeker", stat: "tags", goal: 1000 }, // its reward is the spider face
  { id: "royal", stat: "br_wins", goal: 1 }, // win a Battle Royale
  { id: "jack", stat: "br_wins", goal: 10 },
  { id: "queen" }, // win a Battle Royale without destroying anyone
  { id: "king", stat: "br_wins", goal: 100 },
  { id: "merciless" }, // destroy 5 diggers, then win a Battle Royale
];
const INDEX = new Map(ACHIEVEMENTS.map((a, i) => [a.id, i]));

const ZERO = { kills: 0, dirt: 0, gold: 0, tags: 0, br_wins: 0, ores: 0 };

export class Achievements {
  constructor(conn) {
    this.conn = conn;
    this.unlocked = new Set();
    this.totals = { ...ZERO };
  }

  // a 55GMS account's achievements and totals (null: a guest's start afresh)
  load(account) {
    this.unlocked = new Set(account?.achievements || []);
    this.totals = { ...ZERO, ...(account?.stats || {}) };
  }

  // lifetime total of a stat, counting the life being played
  total(stat, d) {
    const life = d && !d.statsSaved ? d.life : null;
    if (stat === "ores") return oreCount(this.totals.ores | (life?.ores || 0));
    return (this.totals[stat] || 0) + (life?.[stat] || 0);
  }

  // view field 43: 0-100 for each achievement
  progress(d) {
    return ACHIEVEMENTS.map((a) => {
      if (this.unlocked.has(a.id)) return 100;
      if (!a.stat) return 0;
      return Math.min(99, Math.floor((this.total(a.stat, d) / a.goal) * 100));
    });
  }

  unlock(id) {
    if (this.unlocked.has(id)) return;
    this.unlocked.add(id);
    this.conn.showAchievement(INDEX.get(id));
    const account = this.conn.account;
    if (!account) return;
    unlockAchievement(account.uuid, id).then((after) => {
      if (after && this.conn.account?.uuid === after.uuid) {
        this.conn.account.gold = after.gold;
        this.conn.account.items = after.items;
      }
    });
  }

  // the lifetime goals, whenever a total may have moved
  checkTotals(d) {
    for (const a of ACHIEVEMENTS) if (a.stat && this.total(a.stat, d) >= a.goal) this.unlock(a.id);
  }

  // every tick, for the player's own digger; ranked: the lobby, biggest first
  tick(d, ranked) {
    if (!d?.alive) return;
    const t = d.world.tick;
    const life = d.life;
    const score = d.shownScore;
    const alive = t - d.spawnTick;
    if (score >= 10_000) this.unlock("score_1");
    if (score >= 100_000) this.unlock("score_2");
    if (score >= 1_000_000) this.unlock("score_3");
    if (score >= 10_000 && !life.dirt) {
      this.unlock("miner_not_digger");
      if (!life.uranium && !life.kills) this.unlock("how");
    }
    if (d.maxScore >= 100_000 && score <= 10_000) this.unlock("deflation");
    if (life.lava) this.unlock("ouch");
    if (life.lava >= 1000) this.unlock("mechanic_abuse");
    if ((life.ores & ALL_ORES) === ALL_ORES) this.unlock("efficient_collector");
    if (life.tags >= 5) this.unlock("efficient_seeker");
    if (alive >= sec(5 * 60)) this.unlock("survivor");
    if (alive >= sec(60 * 60)) this.unlock("willpower");
    if (t - Math.max(d.spawnTick, d.lastKillTick ?? -Infinity) >= sec(30 * 60)) this.unlock("pacifist");
    // the leaderboard's top, and how long in a row
    if (ranked.length > 1 && ranked[0] === d) {
      this.unlock("leader");
      d.leaderSince ??= t;
      if (t - d.leaderSince >= sec(30 * 60)) this.unlock("supreme_leader");
    } else d.leaderSince = null;
    // kills within 15 s of each other
    let chain = d.killTicks.length ? 1 : 0;
    for (let i = d.killTicks.length - 1; i > 0 && d.killTicks[i] - d.killTicks[i - 1] <= sec(15); i--) chain++;
    if (chain >= 3) this.unlock("triple_kill");
    if (chain >= 5) this.unlock("genocide");
    if (t % 20 === 0) this.checkTotals(d);
  }

  // the player's digger destroyed another (its life counters already count it)
  onKill(d, victim) {
    if (mass(victim) >= mass(d) * 10) this.unlock("david");
    this.checkTotals(d);
  }

  onDeath(d, killer) {
    const t = d.world.tick;
    if (t - d.spawnTick <= sec(5)) this.unlock("speedrun");
    if (d.lastGoldTick != null && t - d.lastGoldTick <= sec(5)) this.unlock("worth_it");
    if (killer && mass(killer) * 10 <= mass(d)) this.unlock("consolation_prize");
  }

  // the player won: a Battle Royale round, or a Tag round as a hider
  onWin(d, mode) {
    if (mode === "tag") return this.unlock("hider");
    if (mode !== "br") return;
    if (!d.life.br_wins) d.life.br_wins = 1;
    if (!d.life.kills) this.unlock("queen");
    if (d.life.kills >= 5) this.unlock("merciless");
    this.checkTotals(d);
  }

  // a life is over: its counters join the lifetime totals (and the account's)
  endLife(d, source) {
    if (!d || d.statsSaved) return;
    this.checkTotals(d);
    d.statsSaved = true;
    const add = {};
    for (const key of ["kills", "dirt", "gold", "tags", "br_wins"]) {
      add[key] = d.life[key];
      this.totals[key] += d.life[key];
    }
    add.ores = d.life.ores;
    this.totals.ores |= d.life.ores;
    const account = this.conn.account;
    if (!account || !Object.values(add).some(Boolean)) return;
    addStats(account.uuid, add, source).then((after) => {
      if (after && this.conn.account?.uuid === account.uuid) this.totals = { ...this.totals, ...after };
    });
  }
}
