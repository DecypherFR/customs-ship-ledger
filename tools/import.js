// Import JSON produced by tools/ledger_to_json.py directly into the database (run on the server).
// Usage: node tools/import.js import.json
'use strict';
const fs = require('node:fs');
const { db, importLedger } = require('../server/server');

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const admin = db.prepare("SELECT * FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").get();
console.log(JSON.stringify(importLedger(admin, data), null, 2));
