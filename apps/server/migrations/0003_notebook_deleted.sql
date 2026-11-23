-- Tombstone for "Delete forever": the row stays so the id can't be re-claimed, but tickets are refused and agents never see it.
ALTER TABLE notebooks ADD COLUMN deleted_at INTEGER;
