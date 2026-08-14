/**
 * Structural check for the Fluxa migrations.
 *
 *   node database/scripts/checkSchema.mjs
 *
 * This is NOT a Postgres parser. No database is available in this environment,
 * so rather than claim the SQL is valid, this catches the specific class of
 * mistake that is easy to make and expensive to find later:
 *
 *   - unbalanced parentheses or quotes
 *   - a FK, policy, grant or index naming a table/column that does not exist
 *   - an enum literal that is not a member of its type
 *   - a policy on a table that never had RLS enabled
 *   - a granted column that is not in the table
 *
 * A pass here means the migrations are internally consistent. It does not mean
 * Postgres will accept them — that needs a real database.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

const files = [
  '0001_initial_schema.sql',
  '0002_rls_policies.sql',
  '0003_sync_state.sql',
  '0004_invoice_preparation.sql',
];
const sql = files
  .map((f) => readFileSync(join(migrations, f), 'utf8'))
  .join('\n');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

/** Strip line comments and dollar-quoted bodies so they don't skew the scan. */
function strip(text) {
  return text
    .replace(/\$\$[\s\S]*?\$\$/g, '$$BODY$$')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const code = strip(sql);

console.log('\nLexical balance');
const opens = (code.match(/\(/g) || []).length;
const closes = (code.match(/\)/g) || []).length;
check(opens === closes, 'parentheses balanced', `${opens} open, ${closes} close`);

const singleQuotes = (code.match(/'/g) || []).length;
check(singleQuotes % 2 === 0, 'single quotes balanced', `${singleQuotes} total`);

console.log('\nEnums');
const enums = {};
for (const m of code.matchAll(/create type (\w+) as enum \(([^)]*)\)/g)) {
  enums[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
check(Object.keys(enums).length === 4, 'four enum types declared',
  Object.keys(enums).join(', '));

console.log('\nTables and columns');
const tables = {};
for (const m of code.matchAll(/create table (\w+) \(([\s\S]*?)\n\);/g)) {
  const [, name, body] = m;
  const cols = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || /^(primary key|unique|check|constraint|foreign key)\b/i.test(t)) continue;
    const col = t.match(/^(\w+)\s+\S/);
    if (col) cols.push(col[1]);
  }
  tables[name] = cols;
}

// Columns added by a later migration are just as real as the ones declared in
// `create table`. Without this, an index or grant naming a column that 0003
// added would be reported as unknown — a false failure that trains you to
// ignore the script, which is worse than not having it.
for (const m of code.matchAll(/alter table (\w+)([\s\S]*?);/g)) {
  const [, name, body] = m;
  for (const add of body.matchAll(/add column (?:if not exists )?(\w+)/g)) {
    if (!tables[name]) continue;
    if (!tables[name].includes(add[1])) tables[name].push(add[1]);
  }
}

for (const [name, cols] of Object.entries(tables)) {
  check(cols.length > 0, `${name} parsed`, `${cols.length} columns`);
}

console.log('\nForeign keys resolve');
for (const m of code.matchAll(/references (\w+)\s*\((\w+)\)/g)) {
  const [, table, col] = m;
  if (table === 'users') {
    check(true, 'auth.users (Supabase-provided)', 'assumed present');
    continue;
  }
  check(
    tables[table]?.includes(col),
    `references ${table}(${col})`,
    tables[table] ? '' : 'unknown table',
  );
}

console.log('\nEnum literals used are real members');
const enumCols = {};
for (const [table, cols] of Object.entries(tables)) {
  void cols;
  const body = code.match(
    new RegExp(`create table ${table} \\(([\\s\\S]*?)\\n\\);`),
  )?.[1];
  if (!body) continue;
  for (const line of body.split('\n')) {
    for (const type of Object.keys(enums)) {
      const m = line.trim().match(new RegExp(`^(\\w+)\\s+${type}\\b`));
      if (m) enumCols[`${table}.${m[1]}`] = type;
    }
  }
}
// Every quoted literal in an `in (...)` or `= '...'` against an enum column.
for (const [qualified, type] of Object.entries(enumCols)) {
  const col = qualified.split('.')[1];
  const pattern = new RegExp(`${col}\\s+in\\s*\\(([^)]*)\\)`, 'g');
  for (const m of code.matchAll(pattern)) {
    const literals = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    for (const lit of literals) {
      check(
        enums[type].includes(lit),
        `${qualified} = '${lit}'`,
        enums[type].includes(lit) ? '' : `not in ${type}`,
      );
    }
  }
}

console.log('\nRLS enabled before policies');
const rlsEnabled = new Set(
  [...code.matchAll(/alter table (\w+)\s+enable row level security/g)].map((m) => m[1]),
);
const policyTables = new Set(
  [...code.matchAll(/create policy \w+\s+on (\w+)/g)].map((m) => m[1]),
);
for (const t of policyTables) {
  check(rlsEnabled.has(t), `${t} has RLS enabled`, `${
    [...code.matchAll(new RegExp(`create policy \\w+\\s+on ${t}`, 'g'))].length
  } policies`);
}

console.log('\nGranted columns exist');
for (const m of code.matchAll(/grant (insert|update) \(([^)]*)\) on (\w+)/g)) {
  const [, verb, colList, table] = m;
  const cols = colList.split(',').map((c) => c.trim()).filter(Boolean);
  const unknown = cols.filter((c) => !tables[table]?.includes(c));
  check(
    unknown.length === 0,
    `grant ${verb} on ${table}`,
    unknown.length ? `unknown: ${unknown.join(', ')}` : `${cols.length} columns`,
  );
}

console.log('\nIndexed columns exist');
for (const m of code.matchAll(
  /create (?:unique )?index (\w+)\s+on (\w+)\s*\(([^)]*)\)/g,
)) {
  const [, idx, table, colList] = m;
  const cols = colList
    .split(',')
    .map((c) => c.trim().replace(/\s+(asc|desc)$/i, ''))
    .filter(Boolean);
  const unknown = cols.filter((c) => !tables[table]?.includes(c));
  check(unknown.length === 0, idx, unknown.length ? `unknown: ${unknown.join(', ')}` : table);
}

console.log('\nMoney columns are never float');
const floatish = [...code.matchAll(/^\s*(\w+)\s+(real|double precision|float\d*)/gim)];
check(floatish.length === 0, 'no float/real/double columns',
  floatish.length ? floatish.map((m) => m[1]).join(', ') : 'all NUMERIC');

const amountCols = [...code.matchAll(/^\s*(\w*(?:amount|units)\w*)\s+([\w()., ]+)/gim)];
for (const [, col, type] of amountCols) {
  check(
    /numeric/i.test(type),
    `${col} is NUMERIC`,
    type.trim().split(/\s/)[0],
  );
}

console.log(
  failures === 0
    ? '\nSchema is internally consistent. (Not a substitute for running it against Postgres.)\n'
    : `\n${failures} problem(s) found.\n`,
);
if (failures > 0) process.exitCode = 1;
