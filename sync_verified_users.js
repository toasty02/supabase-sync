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
const supabaseAdmin = supabase.auth.admin;

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

for (const u of users) {
  try {
    const { data: existing } = await supabaseAdmin.listUsers({
      page: 1,
      perPage: 1000,
    });

    const userExists = existing?.users.find((user) => user.email === u.email);

    if (!userExists) {
      const generatedPassword = `cibv_${u.id}_user`; // or pull from Odoo later
      console.log(`Creating Supabase Auth user for ${u.email}`);
      await supabaseAdmin.createUser({
        email: u.email,
        password: generatedPassword,
        email_confirm: true,
      });
    }
  } catch (err) {
    console.error(`Failed to process auth user for ${u.email}:`, err.message || err);
  }
}

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

// Get emails of active Odoo users
const activeEmails = users.map((u) => u.email);

// Fetch all Supabase users (including previously synced)
const { data: allUsers, error: fetchError } = await supabase
  .from("verified_users")
  .select("email, active");

if (fetchError) {
  console.error("Error fetching users from Supabase:", fetchError);
  process.exit(1);
}

// Identify users who are now missing from Odoo
const deactivated = allUsers.filter(
  (user) => !activeEmails.includes(user.email) && user.active
);

if (deactivated.length > 0) {
  console.log(`Marking ${deactivated.length} users as inactive in Supabase...`);

  const updates = deactivated.map((user) => ({
    email: user.email,
    active: false,
    marked_at: new Date().toISOString(),
    synced_at: new Date().toISOString()
  }));
  
  const { error: updateError } = await supabase
    .from("verified_users")
    .upsert(updates, { onConflict: "email" });
  
  if (updateError) {
    console.error("Error updating inactive users:", updateError);
    process.exit(1);
  }
  
  // ✅ Immediately delete matching Supabase Auth users
  for (const user of deactivated) {
    try {
      const { data: authUsers } = await supabaseAdmin.listUsers({
        page: 1,
        perPage: 1000,
      });
  
      const match = authUsers?.users.find((u) => u.email === user.email);
      if (match) {
        console.log(`Deleting Supabase Auth user for ${user.email}`);
        await supabaseAdmin.deleteUser(match.id);
      }
    } catch (err) {
      console.error(`Failed to delete auth user ${user.email}:`, err.message || err);
    }
  }
  
// Delete users inactive for more than 7 days
const now = new Date();
const threshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

const { data: expired, error: fetchExpiredError } = await supabase
  .from("verified_users")
  .select("email, marked_at")
  .lte("marked_at", threshold.toISOString())
  .eq("active", false);

if (fetchExpiredError) {
  console.error("Failed to fetch expired users:", fetchExpiredError);
  process.exit(1);
}

if (expired.length > 0) {
  console.log(`Deleting ${expired.length} users permanently...`);

  const { error: deleteExpiredError } = await supabase
    .from("verified_users")
    .delete()
    .in("email", expired.map((u) => u.email));

  if (deleteExpiredError) {
    console.error("Failed to delete expired users:", deleteExpiredError);
    process.exit(1);
  }
}

  const { error: inactiveUserUpdateError } = await supabase
    .from("verified_users")
    .upsert(updates, { onConflict: "email" });

  if (inactiveUserUpdateError ) {
    console.error("Error updating inactive users:", inactiveUserUpdateError );
    process.exit(1);
  }
} else {
  console.log("✅ No deactivated users to mark.");
}

console.log(`✅ Synced ${users.length} users from Odoo.`);
process.exit(0);
