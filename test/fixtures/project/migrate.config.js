/**
 * A project, as far as the executable is concerned: a config it can find and a
 * directory it can read. The driver throws because nothing here should reach
 * one — a case that opens a connection belongs in the lane that has a database.
 */
export default {
  dirs: ['./migrations'],
  driver: () => {
    throw new Error('the fixture driver must not be reached');
  },
};
