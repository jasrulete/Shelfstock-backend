-- ShelfStock database schema
-- Run with: psql $DATABASE_URL -f src/db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  price       NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  category    VARCHAR(100) NOT NULL,
  stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image_url   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Orders: total_amount/currency describe the order as a whole.
-- We never join order_items back to products.price for historical totals -
-- see order_items.price_at_purchase below.
CREATE TABLE IF NOT EXISTS orders (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_amount NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 0),
  currency     VARCHAR(10) NOT NULL DEFAULT 'USD',
  status       VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- order_items.price_at_purchase is a deliberate denormalization / snapshot.
-- If we instead stored only product_id and joined to products.price at read
-- time, every historical order would silently reprice itself whenever a
-- product's price changed later. Snapshotting the price at the moment of
-- purchase is what makes an "order history" actually historical.
CREATE TABLE IF NOT EXISTS order_items (
  id                SERIAL PRIMARY KEY,
  order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  price_at_purchase NUMERIC(10, 2) NOT NULL CHECK (price_at_purchase >= 0)
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
CREATE INDEX IF NOT EXISTS idx_products_name ON products USING GIN (to_tsvector('english', name));
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);

-- Seed categories
INSERT INTO categories (name) VALUES
  ('Electronics'), ('Home & Kitchen'), ('Books'), ('Apparel'), ('Toys')
ON CONFLICT (name) DO NOTHING;

-- Seed a handful of products so the app isn't empty on first run
INSERT INTO products (name, description, price, category, stock, image_url)
VALUES
  ('Wireless Mouse', 'Ergonomic 2.4GHz wireless mouse with USB receiver.', 19.99, 'Electronics', 150, 'https://placehold.co/400x400?text=Mouse'),
  ('Mechanical Keyboard', 'Hot-swappable mechanical keyboard, brown switches.', 79.99, 'Electronics', 60, 'https://placehold.co/400x400?text=Keyboard'),
  ('Stainless Steel Water Bottle', 'Insulated 750ml bottle, keeps drinks cold 24h.', 24.50, 'Home & Kitchen', 200, 'https://placehold.co/400x400?text=Bottle'),
  ('The Pragmatic Programmer', 'Classic software engineering book.', 34.00, 'Books', 80, 'https://placehold.co/400x400?text=Book'),
  ('Cotton T-Shirt', 'Plain crew-neck cotton t-shirt.', 12.99, 'Apparel', 300, 'https://placehold.co/400x400?text=Shirt'),
  ('Building Blocks Set', '250-piece creative building blocks.', 29.99, 'Toys', 90, 'https://placehold.co/400x400?text=Blocks')
ON CONFLICT DO NOTHING;
