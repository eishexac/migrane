import type { Part } from 'migrane';

export const up: Part['up'] = async ({ sql }) => {
  await sql`INSERT INTO widgets (name) VALUES ('one'), ('two')`;
};

export const down: Part['down'] = async ({ sql }) => {
  await sql`DELETE FROM widgets`;
};
