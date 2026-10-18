import { register } from "node:module";

/** Load the server modules under node --test (see hooks.mjs). Import this BEFORE importing any lib/server module. */
register("./hooks.mjs", import.meta.url);
