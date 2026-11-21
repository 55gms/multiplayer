// Every game the server speaks for, by the name in its path: /api/mp/<name>/...
import oneVOne from "./1v1/index.js";
import ducklings from "./ducklings/index.js";
import fartnership from "./fartnership/index.js";
import digdig from "./digdig/index.js";
import smashkarts from "./smashkarts/index.js";
import kartbros, { sessionGame } from "./kartbros/index.js";
import { basketbros, soccerbros, baseballbros, footballbros, hockeybros, wrestlebros, fightbros } from "./bros/index.js";

export default {
  "1v1": oneVOne,
  basketbros,
  soccerbros,
  baseballbros,
  footballbros,
  hockeybros,
  wrestlebros,
  fightbros,
  ducklings,
  digdig,
  smashkarts,
  kartbros,
  // Bike Bros plays on the same servers as Kart Bros (*.kartbros.io), with the same protocol.
  bikebros: sessionGame("bikebros"),
  fartnership,
};
