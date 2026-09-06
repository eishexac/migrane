-- migrate:up
CREATE TABLE products (id serial PRIMARY KEY);
-- migrate:down
DROP TABLE products;
