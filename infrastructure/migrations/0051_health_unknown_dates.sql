-- A missing report date is unknown, never the upload date. Existing dates are
-- deliberately untouched: correcting them requires the original source.
ALTER TABLE health_reports ALTER COLUMN taken_on DROP NOT NULL;
