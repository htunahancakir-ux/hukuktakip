-- Additive only: no business rows or existing indexes are changed.
CREATE INDEX IF NOT EXISTS messages_recipients_active ON han_data.messages USING gin ((body->'recipientIds')) WHERE active;
CREATE INDEX IF NOT EXISTS messages_sender_page ON han_data.messages ((body->>'senderId'),(coalesce(body->>'createdAt','')) DESC,id DESC) WHERE active;
CREATE INDEX IF NOT EXISTS messages_created_page ON han_data.messages ((coalesce(body->>'createdAt','')) DESC,id DESC) WHERE active;
CREATE INDEX IF NOT EXISTS orders_assignee_status_page ON han_data.work_orders ((body->>'assigneeId'),(body->>'status'),(coalesce(body->>'createdAt','')) DESC,id DESC) WHERE active;
CREATE INDEX IF NOT EXISTS orders_assigner_page ON han_data.work_orders ((body->>'assignerId'),(coalesce(body->>'createdAt','')) DESC,id DESC) WHERE active;
CREATE INDEX IF NOT EXISTS orders_created_page ON han_data.work_orders ((coalesce(body->>'createdAt','')) DESC,id DESC) WHERE active;
CREATE INDEX IF NOT EXISTS reminders_open_owner_due ON han_data.reminders ((body->>'accountId'),(coalesce(body->>'dueAt','')),id) WHERE active AND coalesce(body->>'closedAt','')='';
CREATE INDEX IF NOT EXISTS reminders_closed_owner_date ON han_data.reminders ((body->>'accountId'),(coalesce(body->>'closedAt','')) DESC,id DESC) WHERE active AND coalesce(body->>'closedAt','')<>'';
CREATE INDEX IF NOT EXISTS reminders_delivery_due ON han_data.reminders ((body->>'deliveryStatus'),(body->>'dueAt'),id) WHERE active AND coalesce(body->>'closedAt','')='';
CREATE INDEX IF NOT EXISTS reminders_stale_delivery ON han_data.reminders ((body->>'deliveryUpdatedAt'),id) WHERE active AND body->>'deliveryStatus'='sending';
CREATE INDEX IF NOT EXISTS workflow_user_open ON han_data.workflow_notices ((body->>'userId'),ordinal,id) WHERE active AND coalesce(body->>'acknowledgedAt','')='';
CREATE INDEX IF NOT EXISTS workflow_document ON han_data.workflow_notices ((body->>'documentId')) WHERE active;
CREATE INDEX IF NOT EXISTS collection_sequence_active ON han_data.collection_notices (((body->>'sequence')::bigint),id) WHERE active;
CREATE INDEX IF NOT EXISTS documents_workflow_scan ON han_data.documents (id) WHERE active AND staff_id IS NOT NULL AND status NOT IN ('İnfaz','İade');
