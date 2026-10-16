
import { readFileSync } from "node:fs";
import db from "./db.js";


const sql = readFileSync(
  new URL("./schema.sql", import.meta.url),
  "utf8"
);

db.exec(sql);

console.log("Database tables created successfully.");

db.close();
