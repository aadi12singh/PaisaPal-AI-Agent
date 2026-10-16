
import db from "./db.js";

const users = [
  [1, "Rahul", 25000],
  [2, "Priya", 30000],
  [3, "Aman", 20000]
];

const categories = [
  [1, "Food"],
  [2, "Travel"],
  [3, "Rent"],
  [4, "Shopping"],
  [5, "Bills"],
  [6, "Entertainment"],
  [7, "Other"]
];

const now = new Date();

// Get today's date in India.
const dateParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).formatToParts(now);

function getDatePart(type) {
  const part = dateParts.find(item => item.type === type);
  return Number(part.value);
}

const year = getDatePart("year");
const month = getDatePart("month");
const today = getDatePart("day");

function getMonth(offset) {
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));

  const resultYear = date.getUTCFullYear();
  const resultMonth = String(
    date.getUTCMonth() + 1
  ).padStart(2, "0");

  return `${resultYear}-${resultMonth}`;
}

const thisMonth = getMonth(0);
const lastMonth = getMonth(-1);

console.log("Current month:", thisMonth);
console.log("Previous month:", lastMonth);

function seedUsers() {
  const statement = db.prepare(`
    INSERT OR IGNORE INTO users
    (user_id, name, monthly_income)
    VALUES (?, ?, ?)
  `);

  for (const user of users) {
    statement.run(...user);
  }
}

function seedCategories() {
  const statement = db.prepare(`
    INSERT OR IGNORE INTO categories
    (category_id, name)
    VALUES (?, ?)
  `);

  for (const category of categories) {
    statement.run(...category);
  }
}

function seedTransactions() {
  const insert = db.prepare(`
    INSERT INTO transactions
    (user_id, amount, type, category_id, note, txn_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const periods = [lastMonth, thisMonth];

  for (const user of users) {
    const userId = user[0];

    for (const period of periods) {
      for (let i = 1; i <= 15; i++) {
        const categoryId = ((i - 1) % 7) + 1;

        const amount = 100 + i * 35 + userId * 20;

        // Avoid future dates in the current month.
        const day = period === thisMonth
          ? Math.min(i, today)
          : i;

        const date = `${period}-${String(day).padStart(2, "0")}`;

        const note = `Demo expense ${i} for ${period}`;

        // Do not insert the same demo transaction twice.
        const existing = db.prepare(`
          SELECT txn_id
          FROM transactions
          WHERE user_id = ?
            AND note = ?
        `).get(userId, note);

        if (!existing) {
          insert.run(
            userId,
            amount,
            "EXPENSE",
            categoryId,
            note,
            date
          );
        }
      }
    }
  }
}

function seedBudgets() {
  const budgets = [
    [1, 5000],  // Food
    [2, 3000],  // Travel
    [4, 4000],  // Shopping
    [5, 2500]   // Bills
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO budgets
    (user_id, category_id, month, limit_amount)
    VALUES (?, ?, ?, ?)
  `);

  for (const user of users) {
    const userId = user[0];

    for (const budget of budgets) {
      const categoryId = budget[0];
      const limit = budget[1];

      insert.run(
        userId,
        categoryId,
        thisMonth,
        limit
      );
    }
  }
}

try {
  db.exec("BEGIN TRANSACTION");

  seedUsers();
  seedCategories();
  seedTransactions();
  seedBudgets();

  db.exec("COMMIT");

  console.log("Seed data added successfully.");
} catch (error) {
  db.exec("ROLLBACK");

  console.error("Seeding failed:", error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
