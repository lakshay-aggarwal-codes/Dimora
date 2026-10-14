// User model v2 (P02-T01).
//
//   - email: trimmed, lower-case, unique index (email_1)
//   - new fields: displayName, role, status, bio, emailVerifiedAt, createdAt,
//     updatedAt (avatar stays absent until the user uploads one)
//
// Never deletes or merges users and never reads or writes hash/salt.
//
// If two accounts share an address (ignoring case and spaces) the unique index
// cannot be built. The migration then writes NOTHING, lists the affected user
// ids and usernames, and stops; the owner fixes the addresses by hand (see
// docs/MIGRATIONS.md) and runs it again. A dry run reports the same problems
// without failing.
//
// Safe to repeat: every update only fills what is missing or not yet normal.
const EMAIL_INDEX_NAME = "email_1";
const BATCH_SIZE = 500;

const PROJECTION = {
  username: 1,
  email: 1,
  displayName: 1,
  role: 1,
  status: 1,
  bio: 1,
  emailVerifiedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email || null;
}

function has(doc, field) {
  return doc[field] !== undefined;
}

function idText(id) {
  return String(id);
}

function createdAtFromId(id) {
  return id && typeof id.getTimestamp === "function"
    ? id.getTimestamp()
    : new Date();
}

/**
 * Pure planning step: decides what to change without touching the database.
 *
 * @param {object[]} users documents with the fields in PROJECTION
 * @returns {{
 *   updates: {_id: *, email?: string, set: object}[],
 *   duplicates: {users: {id: string, username: string}[]}[],
 *   withoutEmail: {id: string, username: string}[],
 *   counts: object
 * }}
 */
function planUserMigration(users) {
  const updates = [];
  const byEmail = new Map();
  const withoutEmail = [];
  let emailsNormalized = 0;

  for (const user of users) {
    const who = { id: idText(user._id), username: String(user.username) };
    const email = normalizeEmail(user.email);
    if (!email) {
      withoutEmail.push(who);
      continue;
    }
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(who);

    const set = {};
    if (email !== user.email) {
      set.email = email;
      emailsNormalized += 1;
    }
    if (typeof user.displayName !== "string" || !user.displayName.trim()) {
      set.displayName = user.username;
    }
    if (!has(user, "role")) set.role = "member";
    if (!has(user, "status")) set.status = "active";
    if (!has(user, "bio")) set.bio = "";
    if (!has(user, "emailVerifiedAt")) set.emailVerifiedAt = null;
    if (!has(user, "createdAt")) set.createdAt = createdAtFromId(user._id);
    if (!has(user, "updatedAt")) {
      set.updatedAt = set.createdAt || user.createdAt || new Date();
    }

    if (Object.keys(set).length) {
      updates.push({ _id: user._id, originalEmail: user.email, set });
    }
  }

  const duplicates = [...byEmail.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({ users: group }));

  return {
    updates,
    duplicates,
    withoutEmail,
    counts: {
      scanned: users.length,
      toUpdate: updates.length,
      emailsNormalized,
      duplicateEmailGroups: duplicates.length,
      usersWithoutEmail: withoutEmail.length,
    },
  };
}

/** One readable line per problem; user ids and usernames only, no emails. */
function describeProblems(plan) {
  const lines = [];
  for (const group of plan.duplicates) {
    lines.push(
      `${group.users.length} accounts share one email address: ${group.users
        .map((u) => `${u.id} (${u.username})`)
        .join(", ")}`,
    );
  }
  for (const u of plan.withoutEmail) {
    lines.push(`account without a usable email: ${u.id} (${u.username})`);
  }
  return lines;
}

module.exports = {
  async up(db, ctx = {}) {
    const users = db.collection("users");
    const documents = await users
      .find({}, { projection: PROJECTION })
      .toArray();
    const plan = planUserMigration(documents);
    const problems = describeProblems(plan);

    if (problems.length) {
      for (const line of problems) ctx.log && ctx.log(`PROBLEM: ${line}`);
      if (!ctx.dryRun) {
        throw new Error(
          `Cannot build the unique email index. Nothing was changed. Fix these accounts by hand (change or remove one address per group; see docs/MIGRATIONS.md), then run the migration again:\n${problems
            .map((p) => `  - ${p}`)
            .join("\n")}`,
        );
      }
    }

    if (ctx.dryRun) {
      return {
        ...plan.counts,
        wouldBlock: problems.length ? 1 : 0,
      };
    }

    let modified = 0;
    for (let i = 0; i < plan.updates.length; i += BATCH_SIZE) {
      const operations = plan.updates
        .slice(i, i + BATCH_SIZE)
        .map(({ _id, originalEmail, set }) => ({
          updateOne: {
            // Matching on the email we read keeps a concurrent edit safe.
            filter: set.email ? { _id, email: originalEmail } : { _id },
            update: { $set: set },
          },
        }));
      const result = await users.bulkWrite(operations, { ordered: false });
      modified += result.modifiedCount || 0;
    }

    await users.createIndex(
      { email: 1 },
      { unique: true, name: EMAIL_INDEX_NAME },
    );

    return {
      scanned: plan.counts.scanned,
      updated: modified,
      emailsNormalized: plan.counts.emailsNormalized,
      indexes: 1,
    };
  },

  // exported for tests
  planUserMigration,
  describeProblems,
  normalizeEmail,
};
