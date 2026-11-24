-- Clinical-trial marker on a medication: null, or { name, cycleDays }.
-- Groundwork for a per-trial tracker (cycles, visits, adverse events).
ALTER TABLE medications ADD COLUMN trial jsonb;
