-- Support tickets can now be opened by an office's own managers (CEO/admin) from inside the
-- application, not only recorded by an operator. The office never gets table access: the
-- application server writes through the control-plane pool and scopes every query to the
-- office it serves.

ALTER TABLE han_saas.support_tickets
  ALTER COLUMN created_by DROP NOT NULL,
  ADD COLUMN opened_by_office text CHECK (opened_by_office IS NULL OR length(opened_by_office) <= 160),
  ADD CONSTRAINT support_tickets_has_author CHECK (created_by IS NOT NULL OR opened_by_office IS NOT NULL);

-- Who wrote a customer message when it was typed by an office user rather than recorded by
-- an operator (author_id stays NULL for those).
ALTER TABLE han_saas.support_messages
  ADD COLUMN author_label text CHECK (author_label IS NULL OR length(author_label) <= 160);
