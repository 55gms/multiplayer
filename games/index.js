// Every game the server speaks for, by the name in its path: /api/mp/<name>/...
import oneVOne from "./1v1/index.js";
import { basketbros, soccerbros, baseballbros, footballbros } from "./bros/index.js";

export default {
  "1v1": oneVOne,
  basketbros,
  soccerbros,
  baseballbros,
  footballbros,
};
