// Password hashing, sessions and the role/permission model.
'use strict';
const crypto = require('node:crypto');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, s, k] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(k, 'base64');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ---- Roles ----------------------------------------------------------------
// Station-scoped roles only see/modify calls at their own station when the user has a
// station_code; a user with no station_code has national scope.
const ROLES = {
  officer: {
    label: 'Customs Officer',
    desc: 'Boards and clears vessels at their station; records calls, departures and Ship\'s Reports; requests extensions.',
    perms: ['calls.read', 'calls.create', 'calls.edit', 'calls.depart', 'ext.request', 'report.print', 'dashboard.view'],
  },
  supervisor: {
    label: 'Station Supervisor',
    desc: 'Everything an officer can do, plus approves extensions, verifies/locks calls and views the overstay register for the station.',
    perms: ['calls.read', 'calls.create', 'calls.edit', 'calls.depart', 'calls.verify', 'ext.request', 'ext.approve',
      'report.print', 'dashboard.view', 'overstay.view', 'cases.manage', 'export'],
  },
  investigator: {
    label: 'Investigations Officer',
    desc: 'National read access; runs the overstay register, opens cases, records follow-up notes.',
    perms: ['calls.read', 'report.print', 'dashboard.view', 'overstay.view', 'cases.manage', 'export'],
  },
  management: {
    label: 'Comptroller / Management',
    desc: 'National read-only access to the ledger, dashboard, overstay register, exports and audit trail.',
    perms: ['calls.read', 'report.print', 'dashboard.view', 'overstay.view', 'export', 'audit.view'],
  },
  admin: {
    label: 'System Administrator',
    desc: 'Manages users, reference lists and settings. Full access, including corrections to verified records.',
    perms: ['*'],
  },
};
const STATION_SCOPED = new Set(['officer', 'supervisor']);

function can(user, perm) {
  const r = ROLES[user && user.role];
  return !!r && (r.perms.includes('*') || r.perms.includes(perm));
}
// Station filter for queries; null means all stations.
function stationScope(user) {
  return STATION_SCOPED.has(user.role) && user.station_code ? user.station_code : null;
}

module.exports = { hashPassword, verifyPassword, passwordProblem, newToken, hashToken, ROLES, can, stationScope };
