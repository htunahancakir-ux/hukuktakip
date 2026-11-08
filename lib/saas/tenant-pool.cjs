const LEGACY_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Only server-validated tenant IDs belong here. Every operation, including
// one-statement reads and streaming transactions, runs under the RLS role.
function createTenantPool(pool, tenantId) {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw Error('Invalid tenant ID');
  if (pool.tenantId) {
    if (pool.tenantId !== tenantId) throw Error('Cannot rebind a tenant connection');
    return pool;
  }
  return {
    tenantId,
    async connect() {
      const client = await pool.connect();
      let transaction = false;
      let released = false;
      async function begin(sql = 'BEGIN') {
        await client.query(sql);
        transaction = true;
        try {
          await client.query("SELECT set_config('han.tenant_id', $1, true)", [tenantId]);
          await client.query('SET LOCAL ROLE han_tenant_runtime');
        } catch (error) {
          await client.query('ROLLBACK');
          transaction = false;
          throw error;
        }
      }
      return {
        async query(sql, params) {
          if (released) throw Error('Connection already released');
          if (typeof sql !== 'string') throw Error('Tenant queries must use SQL text');
          if (/^BEGIN(?:\s|;|$)/i.test(sql)) {
            if (transaction) throw Error('Nested transactions are not supported');
            return begin(sql);
          }
          if (/^(COMMIT|ROLLBACK)\s*;?$/i.test(sql)) {
            try {
              return await client.query(sql);
            } finally {
              transaction = false;
            }
          }
          if (transaction) return client.query(sql, params);
          await begin();
          try {
            const result = await client.query(sql, params);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            transaction = false;
          }
        },
        release() {
          if (released) return;
          released = true;
          // A leaked transaction must never return to the shared pool.
          client.release(transaction ? Error('Unfinished tenant transaction') : undefined);
        },
      };
    },
    async query(sql, params) {
      const client = await this.connect();
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    },
  };
}

module.exports = { createTenantPool, LEGACY_TENANT_ID };
