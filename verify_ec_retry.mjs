// Google Enhanced Conversions retry policy — ceilings, terminal states and queue exclusion.
// Added 2026-09-16 after a CONVERSION_NOT_FOUND refund adjustment retried ~37 times in 19h. It was bounded
// (EC_MAX_AGE_HOURS would have expired it at 24h) but every one of those attempts was known-useless work.
import { classifyEcError, ecRetryDecision, EC_DUE_SQL, EC_PARK_REFUNDS_SQL } from './src/google-ec.js';
import { DatabaseSync } from 'node:sqlite';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { console.log('PASS', name); pass++; } else { console.log('FAIL', name, extra); fail++; } };
const eq = (a, b, name) => ok(a === b, name, `- got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const NF = 12, MAX = 48, AGE = 24 * 3600000;
const decide = (errText, attemptsBefore, ageMs = 0) =>
  ecRetryDecision({ errText, attemptsBefore, ageMs, maxAttempts: MAX, notFoundMaxAttempts: NF, maxAgeMs: AGE });

console.log('--- classification ---');
eq(classifyEcError('{"errorCode":"CONVERSION_NOT_FOUND"} not found'), 'not_found', 'CONVERSION_NOT_FOUND -> not_found');
eq(classifyEcError('CONVERSION_ADJUSTMENT_TOO_RECENT'), 'transient', 'TOO_RECENT -> transient (NOT the short ceiling)');
eq(classifyEcError('RESOURCE_EXHAUSTED'), 'transient', 'RESOURCE_EXHAUSTED -> transient');
eq(classifyEcError('CONCURRENT_MODIFICATION'), 'transient', 'CONCURRENT -> transient');
eq(classifyEcError('INTERNAL_ERROR'), 'transient', 'INTERNAL -> transient');
eq(classifyEcError('TRANSIENT_ERROR'), 'transient', 'TRANSIENT -> transient');
eq(classifyEcError('INVALID_CONVERSION_ACTION'), 'permanent', 'unrecognised error -> permanent');
eq(classifyEcError('TOO_RECENT and NOT_FOUND'), 'transient', 'text with both -> transient, never the short ceiling');
eq(classifyEcError(''), 'permanent', 'empty error text -> permanent, never retried');
eq(classifyEcError(undefined), 'permanent', 'undefined error text -> permanent, never retried');

console.log('\n--- attempt-count semantics (attemptsBefore is the count BEFORE this pass) ---');
eq(decide('CONVERSION_NOT_FOUND', 0).attemptsMade, 1, 'attemptsBefore=0 means the attempt just made is number 1');
eq(decide('CONVERSION_NOT_FOUND', 11).attemptsMade, 12, 'attemptsBefore=11 means the attempt just made is number 12');

console.log('\n--- NOT_FOUND: retries below its ceiling, abandoned at it ---');
let retries = 0;
for (let before = 0; before <= 10; before++) if (decide('CONVERSION_NOT_FOUND', before).action === 'retry') retries++;
eq(retries, 11, 'NOT_FOUND retries for attemptsBefore 0..10 (attempts 1..11), i.e. 11 retries');
eq(decide('CONVERSION_NOT_FOUND', 10).action, 'retry', 'NOT_FOUND attempt 11 of 12 still retries');
eq(decide('CONVERSION_NOT_FOUND', 11).action, 'abandon', 'NOT_FOUND attempt 12 of 12 is abandoned');
eq(decide('CONVERSION_NOT_FOUND', 11).ceiling, NF, 'NOT_FOUND uses the short ceiling');
ok(decide('CONVERSION_NOT_FOUND', 11).why.includes('ceiling'), 'abandon reason names the ceiling');
eq(decide('CONVERSION_NOT_FOUND', 40).action, 'abandon', 'NOT_FOUND well past its ceiling stays abandoned');

console.log('\n--- transient: longer runway, unaffected by the NOT_FOUND ceiling ---');
eq(decide('CONVERSION_ADJUSTMENT_TOO_RECENT', 11).action, 'retry', 'TOO_RECENT still retries at the NOT_FOUND ceiling');
eq(decide('CONVERSION_ADJUSTMENT_TOO_RECENT', 20).action, 'retry', 'TOO_RECENT still retries well beyond it');
eq(decide('INTERNAL_ERROR', 46).action, 'retry', 'transient attempt 47 of 48 still retries');
eq(decide('INTERNAL_ERROR', 47).action, 'abandon', 'transient attempt 48 of 48 is abandoned');
eq(decide('INTERNAL_ERROR', 47).ceiling, MAX, 'transient uses the long ceiling');

console.log('\n--- age ceiling ---');
eq(decide('INTERNAL_ERROR', 0, AGE + 1).action, 'abandon', 'age ceiling abandons a transient row on its first attempt');
eq(decide('INTERNAL_ERROR', 0, AGE + 1).why, 'past age ceiling', 'age abandon is labelled as such, not as a ceiling hit');
eq(decide('CONVERSION_NOT_FOUND', 0, AGE + 1).action, 'abandon', 'age ceiling abandons a not_found row too');
eq(decide('INTERNAL_ERROR', 0, AGE - 1).action, 'retry', 'a row just inside the age ceiling still retries');

console.log('\n--- permanent errors unchanged ---');
eq(decide('INVALID_CONVERSION_ACTION', 0).action, 'fail', 'permanent error fails immediately, as before');
eq(decide('INVALID_CONVERSION_ACTION', 47).action, 'fail', 'permanent error fails regardless of attempts');
eq(decide('', 0).action, 'fail', 'a row with no error text can never be put back on the queue');

console.log('\n--- queue selection: terminal states are not re-attempted (real EC_DUE_SQL) ---');
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE ec_queue (order_id TEXT PRIMARY KEY, payload TEXT, order_created_at INTEGER, due_at INTEGER,
  attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', last_error TEXT, uploaded_at INTEGER, created_at INTEGER)`);
const ins = db.prepare(`INSERT INTO ec_queue (order_id, payload, order_created_at, due_at, attempts, status, last_error) VALUES (?,?,?,?,?,?,?)`);
const now = Date.now();
ins.run('order:pending',   '{}', now, now - 1000, 3,  'pending',   null);
ins.run('refund:abandoned','{}', now, now - 1000, 12, 'abandoned', '[abandoned: not_found ceiling 12 attempts reached] CONVERSION_NOT_FOUND');
ins.run('order:failed',    '{}', now, now - 1000, 1,  'failed',    'INVALID_CONVERSION_ACTION');
ins.run('order:expired',   '{}', now, now - 1000, 5,  'expired',   'past 24h enhancement window');
ins.run('order:done',      '{}', now, now - 1000, 1,  'done',      null);
const due = db.prepare(EC_DUE_SQL).all(now, 200).map(r => r.order_id);
eq(due.length, 1, 'exactly one row is due');
eq(due[0], 'order:pending', 'only the pending row is selected');
ok(!due.includes('refund:abandoned'), 'abandoned rows are NOT selected by qDue');
ok(!due.includes('order:failed') && !due.includes('order:expired') && !due.includes('order:done'), 'other terminal states also excluded');

const ab = db.prepare(`SELECT order_id, attempts, last_error FROM ec_queue WHERE status='abandoned'`).all();
eq(ab.length, 1, 'abandoned row is retained, not deleted');
ok(ab[0].last_error && ab[0].last_error.includes('CONVERSION_NOT_FOUND'), 'abandoned row preserves the original error for diagnostics');
ok(ab[0].last_error.startsWith('[abandoned:'), 'abandoned row records why it was abandoned');
eq(ab[0].attempts, 12, 'abandoned row preserves its attempt count');


console.log('\n--- EC_REFUNDS=off: parking pending refund rows (real EC_PARK_REFUNDS_SQL) ---');
const db2 = new DatabaseSync(':memory:');
db2.exec(`CREATE TABLE ec_queue (order_id TEXT PRIMARY KEY, payload TEXT, order_created_at INTEGER, due_at INTEGER,
  attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', last_error TEXT, uploaded_at INTEGER, created_at INTEGER)`);
const ins2 = db2.prepare(`INSERT INTO ec_queue (order_id, payload, order_created_at, due_at, attempts, status, last_error) VALUES (?,?,?,?,?,?,?)`);
const now2 = Date.now();
ins2.run('refund:111', '{}', now2, now2-1000, 3,  'pending',   'CONVERSION_NOT_FOUND');
ins2.run('refund:222', '{}', now2, now2-1000, 9,  'pending',   null);
ins2.run('refund:333', '{}', now2, now2-1000, 12, 'abandoned', '[abandoned: not_found ceiling 12 attempts reached]');
ins2.run('refund:444', '{}', now2, now2-1000, 41, 'expired',   'past 24h enhancement window');
ins2.run('17266778177923', '{}', now2, now2-1000, 0, 'pending', null);
ins2.run('17264840900995', '{}', now2, now2-1000, 1, 'done',    null);
const parked = db2.prepare(EC_PARK_REFUNDS_SQL).run().changes;
eq(parked, 2, 'parks exactly the two PENDING refund rows');
const st = (id) => db2.prepare('SELECT status FROM ec_queue WHERE order_id=?').get(id).status;
eq(st('refund:111'), 'refunds_disabled', 'pending refund row is parked');
eq(st('refund:222'), 'refunds_disabled', 'second pending refund row is parked');
eq(st('refund:333'), 'abandoned', 'already-abandoned refund row untouched (history preserved)');
eq(st('refund:444'), 'expired', 'already-expired refund row untouched');
eq(st('17266778177923'), 'pending', 'PENDING ENHANCEMENT row NOT parked - purchase EC path unaffected');
eq(st('17264840900995'), 'done', 'completed enhancement row untouched');
const due2 = db2.prepare(EC_DUE_SQL).all(now2, 200).map(r => r.order_id);
eq(due2.length, 1, 'only one row remains due after parking');
eq(due2[0], '17266778177923', 'the remaining due row is the enhancement row, not a refund');
ok(!due2.some(x => String(x).startsWith('refund:')), 'no refund row is selected for upload once parked');
const perr = db2.prepare("SELECT last_error FROM ec_queue WHERE order_id='refund:111'").get().last_error;
ok(perr && perr.includes('CONVERSION_NOT_FOUND'), 'parked row keeps its last_error for diagnostics');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
