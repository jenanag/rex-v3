import { english } from "./en/index.js";

export const packs = new Map([["en", english]]);
export type Pack = typeof english;
