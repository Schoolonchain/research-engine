CREATE INDEX supports_active_subject_key_id_idx
  ON supports (subject_key_id)
  WHERE status = 'ACTIVE';
