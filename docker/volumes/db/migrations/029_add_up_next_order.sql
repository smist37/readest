-- Migration 029: Add `up_next_order` + `up_next_order_updated_at` to books
--
-- The book's position in the Up Next queue (reading_status = 'upnext'),
-- ascending. A reorder stamps only up_next_order_updated_at and leaves
-- updated_at (the Date Read sort key) alone, so the position merges
-- field-level last-writer-wins on its own clock, the same way 015
-- reading_status_updated_at (#4634) resolves the status.
--
-- Additive + nullable; NULL is treated as epoch 0 (oldest) by the merge. A
-- push without the columns (old clients, the KOReader and Calibre plugins)
-- carries no stamp, so it never overrides a stamped position. Old clients
-- ignore the columns, so they never break. Not backfilled: no row is Up Next
-- before this.

ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS up_next_order double precision NULL,
  ADD COLUMN IF NOT EXISTS up_next_order_updated_at timestamp with time zone NULL;
