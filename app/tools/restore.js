'use strict';
// Giai ma 1 file sao luu: node tools/restore.js <file-khoa.pem> <file.vmt> <file-ra>
// File .db.gz.vmt -> ra file .db (tu giai nen). File anh .jpg.vmt -> ra .jpg
const fs = require('node:fs'); const zlib = require('node:zlib');
const { open } = require('../lib/backup');
const [key, inp, out] = process.argv.slice(2);
if (!key || !inp || !out) { console.log('Cach dung: node tools/restore.js khoa.pem file.vmt file-ra'); process.exit(1); }
let data = open(fs.readFileSync(key, 'utf8'), fs.readFileSync(inp));
if (/\.gz\.vmt$/.test(inp)) data = zlib.gunzipSync(data);
fs.writeFileSync(out, data); console.log('Da giai ma:', out, data.length, 'byte');
