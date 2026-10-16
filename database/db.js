
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";


mkdirSync("data", { recursive: true });

const databasePath = join("data", "paisapal.db");

const db = new DatabaseSync(databasePath);

db.exec("PRAGMA foreign_keys = ON");

export default db;