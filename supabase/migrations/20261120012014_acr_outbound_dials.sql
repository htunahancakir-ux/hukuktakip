CREATE TABLE han_private.acr_outbound_dials (
  tenant_id uuid NOT NULL DEFAULT han_private.current_tenant() REFERENCES han_saas.tenants(id),
  id uuid NOT NULL,
  user_id text NOT NULL,
  device_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX acr_outbound_dials_inbox ON han_private.acr_outbound_dials(tenant_id, user_id, expires_at);
CREATE INDEX acr_outbound_dials_device ON han_private.acr_outbound_dials(tenant_id, device_id, expires_at);
CREATE INDEX acr_outbound_dials_expiry ON han_private.acr_outbound_dials(tenant_id, expires_at);
CREATE INDEX voip_card_history ON han_private.voip_calls
  (tenant_id, (body->>'cardType'), (body->>'cardId'), created_at DESC) WHERE body ? 'cardId';
ALTER TABLE han_private.acr_outbound_dials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON han_private.acr_outbound_dials FROM PUBLIC;
CREATE POLICY tenant_isolation ON han_private.acr_outbound_dials TO han_tenant_runtime
  USING (tenant_id = nullif(current_setting('han.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('han.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON han_private.acr_outbound_dials TO han_tenant_runtime;
