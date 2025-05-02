// sync_verified_users.js
import xmlrpc from "xmlrpc";
import { createClient } from "@supabase/supabase-js";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ODOO_URL,
  ODOO_DB,
  ODOO_USER,
  ODOO_PASS,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// XML-RPC auth
const common = xmlrpc.createClient({ url: `${ODOO_URL}/xmlrpc/2/common` });
const models = xmlrpc.createClient({ url: `${ODOO_URL}/xmlrpc/2/object` });

const uid = await new Promise((resolve, reject) => {
  common.methodCall("authenticate", [ODOO_DB, ODOO_USER, ODOO_PASS, {}], (err, value) => {
    if (err) return reject(err);
    resolve(value);
  });
});

const users = await new Promise((resolve, reject) => {
  models.methodCall(
    "execute_kw",
    [
      ODOO_DB,
      uid,
      ODOO_PASS,
      "res.users",
      "search_read",
      [[["active", "=", true]]],
      { fields: ["id", "name", "email"] },
    ],
    (err, value) => {
      if (err) return reject(err);
      resolve(value);
    }
  );
});

const { error } = await supabase
  .from("verified_users")
  .upsert(
    users.map((u) => ({
      source_id: u.id,
      name: u.name,
      email: u.email,
      active: true,
      synced_at: new Date().toISOString(),
    })),
    { onConflict: "email" }
  );

if (error) {
  console.error("Supabase error:", error);
  process.exit(1);
}

console.log(`✅ Synced ${users.length} users from Odoo.`);
process.exit(0);
