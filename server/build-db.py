#!/usr/bin/env python3
"""Build focusguard.db from a D1 dump + the repo migrations.

Usage: build-db.py <dump.json.gz> <migrations_dir> <output.db>

Applies backend/migrations/*.sql in order, then INSERTs every dumped row.
Verifies foreign keys, integrity and per-table counts at the end.
"""
import gzip
import json
import os
import sqlite3
import sys

dump_path, mig_dir, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

if os.path.exists(out_path):
    os.remove(out_path)
for suffix in ("-wal", "-shm"):
    if os.path.exists(out_path + suffix):
        os.remove(out_path + suffix)

db = sqlite3.connect(out_path)
db.execute("PRAGMA journal_mode=WAL")
for name in sorted(f for f in os.listdir(mig_dir) if f.endswith(".sql")):
    sql = open(os.path.join(mig_dir, name)).read()
    db.executescript(sql)
    print("applied", name)

with gzip.open(dump_path, "rt", encoding="utf-8") as f:
    dump = json.load(f)

for table, rows in dump["tables"].items():
    if not rows:
        print(table, "0 rows (skipped)")
        continue
    cols = list(rows[0].keys())
    placeholders = ",".join("?" for _ in cols)
    col_list = ",".join(f'"{c}"' for c in cols)
    db.executemany(
        f'INSERT INTO "{table}" ({col_list}) VALUES ({placeholders})',
        [tuple(r[c] for c in cols) for r in rows],
    )
    print(table, len(rows), "rows")

violations = db.execute("PRAGMA foreign_key_check").fetchall()
print("foreign_key_check violations:", violations)
print("integrity_check:", db.execute("PRAGMA integrity_check").fetchone()[0])
for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
    n = db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
    print(f"  {table}: {n}")
db.commit()
db.close()
