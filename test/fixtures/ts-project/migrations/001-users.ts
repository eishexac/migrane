type Run = (context: {
  sql: (s: TemplateStringsArray) => Promise<unknown>;
}) => Promise<void>;

export const up: Run = async ({ sql }) => {
  await sql`CREATE TABLE users (id serial PRIMARY KEY)`;
};

export const down: Run = async ({ sql }) => {
  await sql`DROP TABLE users`;
};
