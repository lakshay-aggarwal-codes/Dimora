// A fingerprint of a database (P17-T05): which collections exist, how many
// documents and which indexes each has, and which migrations were applied. Take
// one before a backup and one after a restore; `compareSnapshots` says what
// differs. It reads counts and names only, never documents.

/** @param {import("mongodb").Db} db */
async function buildSnapshot(db, now = new Date()) {
  const infos = await db.listCollections({}, { nameOnly: true }).toArray();
  const collections = {};
  for (const { name } of infos.filter((c) => !c.name.startsWith("system.")).sort((a, b) => a.name.localeCompare(b.name))) {
    const coll = db.collection(name);
    const [count, indexes] = await Promise.all([coll.countDocuments({}), coll.indexes()]);
    collections[name] = { count, indexes: indexes.map((i) => i.name).sort() };
  }
  let migrations = [];
  if (collections.schema_migrations) {
    migrations = (await db.collection("schema_migrations").find({}, { projection: { _id: 1, id: 1 } }).toArray())
      .map((m) => String(m.id || m._id))
      .sort();
  }
  return { takenAt: now.toISOString(), database: db.databaseName, collections, migrations };
}

/**
 * @returns {{ same: boolean, differences: string[] }}
 * Sessions and notifications change all the time (and expire by themselves), so
 * their counts are reported separately and never make the comparison fail.
 */
function compareSnapshots(before, after, { volatile = ["sessions", "notifications", "emailtokens"] } = {}) {
  const differences = [];
  const notes = [];
  const names = new Set([...Object.keys(before.collections || {}), ...Object.keys(after.collections || {})]);
  for (const name of [...names].sort()) {
    const a = before.collections[name];
    const b = after.collections[name];
    if (!a) differences.push(`${name}: only in the second snapshot`);
    else if (!b) differences.push(`${name}: missing from the second snapshot`);
    else {
      if (a.count !== b.count) {
        (volatile.includes(name) ? notes : differences).push(`${name}: ${a.count} documents, then ${b.count}`);
      }
      const missing = a.indexes.filter((i) => !b.indexes.includes(i));
      const extra = b.indexes.filter((i) => !a.indexes.includes(i));
      if (missing.length) differences.push(`${name}: indexes missing after restore: ${missing.join(", ")}`);
      if (extra.length) notes.push(`${name}: extra indexes: ${extra.join(", ")}`);
    }
  }
  const lost = (before.migrations || []).filter((m) => !(after.migrations || []).includes(m));
  if (lost.length) differences.push(`migrations not recorded after restore: ${lost.join(", ")}`);
  return { same: differences.length === 0, differences, notes };
}

module.exports = { buildSnapshot, compareSnapshots };
