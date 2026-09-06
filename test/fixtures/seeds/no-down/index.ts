import type { Part } from 'migrane';

/** No `down`, which `unseed` has to refuse rather than guess at. */
export const up: Part['up'] = async ({ sql }) => {
  await sql`INSERT INTO widgets (name) VALUES ('irreversible')`;
};
