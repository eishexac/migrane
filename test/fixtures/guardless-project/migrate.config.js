/**
 * A project that declares no guard, with a driver that can be constructed but
 * never reached: the refusal runs before any query, so a destructive command
 * here must exit with the guard code and not this error.
 */
const unreached = () => {
  throw new Error('the fixture driver must not be reached');
};

export default {
  dirs: ['./migrations'],
  driver: () => ({
    host: 'db.example.com',
    database: 'app',
    query: unreached,
    session: unreached,
    close: async () => {},
  }),
};
