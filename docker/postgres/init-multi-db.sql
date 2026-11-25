CREATE DATABASE auth_db;
CREATE DATABASE catalog_db;
CREATE DATABASE order_db;
CREATE DATABASE payment_db;

\connect catalog_db;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
