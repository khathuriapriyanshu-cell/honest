'use strict';

/**
 * Reflections — the "Admit" step.
 *
 * Business rules:
 * - A reflection explains MISSED promises. It cannot be attached to a task
 *   that was completed that day, or to a task that was not scheduled.
 * - Reflecting on today's incomplete tasks is allowed (early honesty —
 *   "I already know I won't get to this").
 * - Off days need no reflection (nothing is owed).
 * - Per-task reflections upsert on (task, date); a day-level note (no
 *   taskIds) is also supported but does NOT resolve a red day — only
 *   explaining the actual missed promises does.
 *
 * Language rule: the product is a mirror, not a bully. Every message here is
 * factual and kind; nothing shames the user.
 */

const { badRequest, notFound, conflict } = require('../utils/errors');
const { addDays } = require('../utils/dates');
const { assertBodyObject, assertOnlyKeys, vDate, vString, vIntArray } = require('../utils/validate');
const { getDayDetail, daySummary } = require('./dayService');

function upsert(db, date, taskId, reason, nowIso) {
  const existing = taskId
    ? db.get('SELECT * FROM reflections WHERE date = ? AND task_id = ?', date, taskId)
    : db.get('SELECT * FROM reflections WHERE date = ? AND task_id IS NULL', date);
  if (existing) {
    db.run('UPDATE reflections SET reason = ?, updated_at = ? WHERE id = ?', reason, nowIso, existing.id);
    return { id: existing.id, date, taskId, reason, createdAt: existing.created_at, updatedAt: nowIso };
  }
  const ins = db.run(
    'INSERT INTO reflections (date, task_id, reason, created_at, updated_at) VALUES (?,?,?,?,?)',
    date,
    taskId,
    reason,
    nowIso,
    nowIso
  );
  return { id: ins.lastInsertRowid, date, taskId, reason, createdAt: nowIso, updatedAt: nowIso };
}

function submitReflection(db, body, { clock }) {
  const input = assertBodyObject(body);
  assertOnlyKeys(input, ['date', 'taskIds', 'reason']);
  const date = vDate(input.date, 'date', { required: true });
  const reason = vString(input.reason, 'reason', { required: true, max: 1000 });
  const taskIds = vIntArray(input.taskIds, 'taskIds', { maxItems: 50 });

  if (date > clock.todayDate) {
    throw badRequest('DATE_IN_FUTURE', 'You cannot record a reflection for a future date.');
  }
  const detail = getDayDetail(db, date, { clock });
  if (detail.offDay) {
    throw conflict('OFF_DAY_REFLECTION', 'This day was marked as an off day — nothing needs an explanation.');
  }

  const nowIso = clock.now.toISOString();
  const saved = [];
  if (taskIds && taskIds.length > 0) {
    for (const taskId of taskIds) {
      const task = db.get('SELECT * FROM tasks WHERE id = ?', taskId);
      if (!task) throw notFound('TASK_NOT_FOUND', `Task ${taskId} does not exist.`);
      const occ = detail.tasks.find((t) => t.taskId === taskId);
      if (!occ) {
        throw conflict('TASK_NOT_SCHEDULED', `"${task.name}" was not scheduled on ${date}.`);
      }
      if (occ.status === 'completed') {
        throw conflict(
          'REFLECTION_FOR_COMPLETED',
          `"${task.name}" was completed on ${date} — there is nothing to explain.`
        );
      }
      saved.push(upsert(db, date, taskId, reason, nowIso));
    }
  } else {
    saved.push(upsert(db, date, null, reason, nowIso));
  }

  const after = getDayDetail(db, date, { clock });
  return {
    date,
    reflections: saved,
    day: daySummary(after),
    message: {
      title: 'Reason recorded.',
      body: "You don't need to justify it to us. You just needed to be honest with yourself.",
      action: 'Start today.',
    },
  };
}

/**
 * Convenience flow used by the night-check / frontend reflect button:
 * without an explicit date, target yesterday while it is unresolved,
 * otherwise today. Without taskIds, apply the reason to every promise that
 * currently owes an explanation on that date.
 */
function reflectAuto(db, body, { clock }) {
  const input = assertBodyObject(body);
  assertOnlyKeys(input, ['date', 'taskIds', 'reason', 'taskName'], 'body');

  let date = vDate(input.date, 'date');
  if (!date) {
    const yesterday = addDays(clock.todayDate, -1);
    const yd = getDayDetail(db, yesterday, { clock });
    date = yd.resolved === false ? yesterday : clock.todayDate;
  }
  if (date > clock.todayDate) {
    throw badRequest('DATE_IN_FUTURE', 'You cannot record a reflection for a future date.');
  }

  const detail = getDayDetail(db, date, { clock });
  if (detail.offDay) {
    throw conflict('OFF_DAY_REFLECTION', 'This day was marked as an off day — nothing needs an explanation.');
  }

  let taskIds = vIntArray(input.taskIds, 'taskIds', { maxItems: 50 });
  if (!taskIds || taskIds.length === 0) {
    const owing =
      date === clock.todayDate
        ? detail.tasks.filter((t) => t.status === 'incomplete' && !t.reflection)
        : detail.tasks.filter((t) => t.status === 'missed_unexplained');
    taskIds = owing.map((t) => t.taskId);
    if (taskIds.length === 0) {
      throw conflict(
        'NOTHING_TO_REFLECT',
        date === clock.todayDate
          ? 'Nothing needs a reason right now. Finish what you can, and be honest about the rest.'
          : `Every missed promise on ${date} already has a reason recorded.`
      );
    }
  }
  return submitReflection(db, { date, taskIds, reason: input.reason }, { clock });
}

function listReflections(db, { date, from, to, taskId, limit } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  if (date) {
    return db
      .all(
        `SELECT r.*, t.name AS task_name FROM reflections r
           LEFT JOIN tasks t ON t.id = r.task_id
          WHERE r.date = ? ORDER BY r.created_at DESC, r.id DESC`,
        date
      )
      .map(reflectionPublic);
  }
  if (from || to) {
    return db
      .all(
        `SELECT r.*, t.name AS task_name FROM reflections r
           LEFT JOIN tasks t ON t.id = r.task_id
          WHERE r.date BETWEEN ? AND ? ORDER BY r.date DESC, r.id DESC`,
        from || '0000-01-01',
        to || '9999-12-31'
      )
      .map(reflectionPublic);
  }
  const rows = taskId
    ? db.all(
        `SELECT r.*, t.name AS task_name FROM reflections r
           LEFT JOIN tasks t ON t.id = r.task_id
          WHERE r.task_id = ? ORDER BY r.date DESC, r.id DESC LIMIT ?`,
        taskId,
        cap
      )
    : db.all(
        `SELECT r.*, t.name AS task_name FROM reflections r
           LEFT JOIN tasks t ON t.id = r.task_id
          ORDER BY r.date DESC, r.id DESC LIMIT ?`,
        cap
      );
  return rows.map(reflectionPublic);
}

function reflectionPublic(row) {
  return {
    id: row.id,
    date: row.date,
    taskId: row.task_id ?? null,
    taskName: row.task_name ?? null,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deleteReflection(db, id) {
  const row = db.get('SELECT * FROM reflections WHERE id = ?', id);
  if (!row) throw notFound('REFLECTION_NOT_FOUND', `Reflection ${id} does not exist.`);
  db.run('DELETE FROM reflections WHERE id = ?', id);
  return { id, deleted: true };
}

module.exports = { submitReflection, reflectAuto, listReflections, deleteReflection };
