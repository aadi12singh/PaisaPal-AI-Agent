import { tool } from "@langchain/core/tools";
import { z } from "zod";
import db from "./database/db.js";


const currentUserId = 1;


let pendingAction = null;

export function getPendingAction() {
  return pendingAction;
}

export function clearPendingAction() {
  pendingAction = null;
}

function runQuery(sql, values = []) {
  return db.prepare(sql).all(...values);
}

function getOne(sql, values = []) {
  return db.prepare(sql).get(...values);
}

export function todayInIndia() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type => parts.find(p => p.type === type).value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);

  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day;
}

function validMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function categoryId(name) {
  const category = getOne(
    "SELECT category_id FROM categories WHERE LOWER(name) = LOWER(?)",
    [name]
  );

  if (!category) {
    throw new Error(`Unknown category: ${name}`);
  }

  return category.category_id;
}

function money(amount) {
  return `₹${Number(amount).toFixed(2)}`;
}

function prepareAction(action) {
  if (pendingAction) {
    return "Another operation is awaiting confirmation. Reply yes or no first.";
  }

  pendingAction = action;
  return `Confirmation required: ${action.description}\nReply yes or no.`;
}


const addTransactionTool = tool(
  async ({ amount, type, category, note, date }) => {
    try {
      if (!validDate(date)) {
        return "Invalid date. Use a real date in YYYY-MM-DD format.";
      }

      const id = categoryId(category);

      return prepareAction({
        kind: "add",
        userId: currentUserId,
        amount,
        type,
        categoryId: id,
        category,
        note,
        date,
        description:
          `Save ${type.toLowerCase()} of ${money(amount)} ` +
          `in ${category} on ${date}?`
      });
    } catch (error) {
      return error.message;
    }
  },
  {
    name: "add_transaction",
    description:
      "Prepare a new income or expense. Requires amount, type, " +
      "category and date. This tool asks for confirmation; it does not save immediately.",
    schema: z.object({
      amount: z.number().positive(),
      type: z.enum(["INCOME", "EXPENSE"]),
      category: z.string().trim().min(1),
      note: z.string().default(""),
      date: z.string()
    })
  }
);

const listTransactionsTool = tool(
  async ({ category, type, startDate, endDate }) => {
    try {
      if (startDate && !validDate(startDate)) {
        return "Invalid start date.";
      }

      if (endDate && !validDate(endDate)) {
        return "Invalid end date.";
      }

      if (startDate && endDate && startDate > endDate) {
        return "Start date must be before or equal to end date.";
      }

      let sql = `
        SELECT t.txn_id, t.amount, t.type,
               c.name AS category, t.note, t.txn_date
        FROM transactions t
        JOIN categories c ON c.category_id = t.category_id
        WHERE t.user_id = ?
      `;

      const values = [currentUserId];

      if (category) {
        sql += " AND LOWER(c.name) = LOWER(?)";
        values.push(category);
      }

      if (type) {
        sql += " AND t.type = ?";
        values.push(type);
      }

      if (startDate) {
        sql += " AND t.txn_date >= ?";
        values.push(startDate);
      }

      if (endDate) {
        sql += " AND t.txn_date <= ?";
        values.push(endDate);
      }

      sql += " ORDER BY t.txn_date DESC, t.txn_id DESC LIMIT 100";

      const transactions = runQuery(sql, values);

      return JSON.stringify({
        count: transactions.length,
        transactions
      });
    } catch (error) {
      return `Unable to list transactions: ${error.message}`;
    }
  },
  {
    name: "list_transactions",
    description:
      "Read the current user's saved transactions. " +
      "Filter by category, type or date range. " +
      "Use this to find transaction IDs before deletion.",
    schema: z.object({
      category: z.string().optional(),
      type: z.enum(["INCOME", "EXPENSE"]).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional()
    })
  }
);


const spendingSummaryTool = tool(
  async ({ month, category }) => {
    console.log("[TOOL CALLED] get_spending_summary", {
  month,
  category
});
    if (!validMonth(month)) {
      return "Invalid month. Use YYYY-MM.";
    }

    const values = [currentUserId, month];
    let categoryFilter = "";

    if (category) {
      categoryFilter = " AND LOWER(c.name) = LOWER(?)";
      values.push(category);
    }

    const rows = runQuery(`
      SELECT
        c.name AS category,
        COUNT(*) AS transaction_count,
        ROUND(SUM(t.amount), 2) AS total
      FROM transactions t
      JOIN categories c ON c.category_id = t.category_id
      WHERE t.user_id = ?
        AND substr(t.txn_date, 1, 7) = ?
        AND t.type = 'EXPENSE'
        ${categoryFilter}
      GROUP BY c.category_id, c.name
      ORDER BY total DESC
    `, values);

    const total = rows.reduce(
      (sum, row) => sum + row.total,
      0
    );

    const categories = rows.map(row => ({
      ...row,
      percentage: total > 0
        ? Number((row.total / total * 100).toFixed(2))
        : 0
    }));

    return JSON.stringify({
      month,
      total_spending: Number(total.toFixed(2)),
      categories
    });
  },
  {
    name: "get_spending_summary",
    description:
      "Calculate actual monthly expense totals by category, " +
      "including each category's percentage of total spending. " +
      "Call separately for two months when comparing spending.",
    schema: z.object({
      month: z.string(),
      category: z.string().optional()
    })
  }
);


const setBudgetTool = tool(
  async ({ category, month, limitAmount }) => {
    try {
      if (!validMonth(month)) {
        return "Invalid month. Use YYYY-MM.";
      }

      const id = categoryId(category);

      return prepareAction({
        kind: "budget",
        userId: currentUserId,
        categoryId: id,
        category,
        month,
        limitAmount,
        description:
          `Set ${category} budget to ${money(limitAmount)} ` +
          `for ${month}?`
      });
    } catch (error) {
      return error.message;
    }
  },
  {
    name: "set_budget",
    description:
      "Prepare a monthly category budget change. " +
      "The user must confirm before the database is updated.",
    schema: z.object({
      category: z.string().trim().min(1),
      month: z.string(),
      limitAmount: z.number().positive()
    })
  }
);


function getBudgetStatuses(userId, month) {
  const rows = runQuery(`
    SELECT
      c.name AS category,
      b.limit_amount AS budget_limit,
      COALESCE(SUM(t.amount), 0) AS spent
    FROM budgets b
    JOIN categories c
      ON c.category_id = b.category_id
    LEFT JOIN transactions t
      ON t.user_id = b.user_id
      AND t.category_id = b.category_id
      AND t.type = 'EXPENSE'
      AND substr(t.txn_date, 1, 7) = b.month
    WHERE b.user_id = ?
      AND b.month = ?
    GROUP BY b.budget_id, c.name, b.limit_amount
    ORDER BY c.name
  `, [userId, month]);

  return rows.map(row => {
    const percentage =
      row.spent / row.budget_limit * 100;

    let status = "SAFE";

    if (percentage > 100) {
      status = "OVER_BUDGET";
    } else if (percentage > 80) {
      status = "WARNING";
    }

    return {
      ...row,
      percentage: Number(percentage.toFixed(2)),
      remaining: Number(
        (row.budget_limit - row.spent).toFixed(2)
      ),
      status
    };
  });
}

const checkBudgetTool = tool(
  async ({ month }) => {
    if (!validMonth(month)) {
      return "Invalid month. Use YYYY-MM.";
    }

    return JSON.stringify({
      month,
      budgets: getBudgetStatuses(currentUserId, month)
    });
  },
  {
    name: "check_budget_status",
    description:
      "Check the current user's monthly category budgets. " +
      "Report spending, limits, percentages and warnings.",
    schema: z.object({
      month: z.string()
    })
  }
);


const deleteTransactionTool = tool(
  async ({ transactionId }) => {
    const transaction = getOne(`
      SELECT
        t.txn_id,
        t.amount,
        t.type,
        t.note,
        t.txn_date,
        c.name AS category
      FROM transactions t
      JOIN categories c
        ON c.category_id = t.category_id
      WHERE t.txn_id = ?
        AND t.user_id = ?
    `, [transactionId, currentUserId]);

    if (!transaction) {
      return "Transaction not found for the current user.";
    }

    return prepareAction({
      kind: "delete",
      userId: currentUserId,
      transactionId,
      description:
        `Delete transaction #${transactionId}: ` +
        `${money(transaction.amount)}, ` +
        `${transaction.category}, ${transaction.txn_date}, ` +
        `"${transaction.note}"?`
    });
  },
  {
    name: "delete_transaction",
    description:
      "Prepare deletion of one transaction by its exact ID. " +
      "Always show its details and require confirmation.",
    schema: z.object({
      transactionId: z.number().int().positive()
    })
  }
);



export function executeConfirmedAction(action) {
  if (action.userId !== currentUserId) {
    throw new Error("User mismatch.");
  }
  

  if (action.kind === 'recurring_add') {
    const result = db.prepare(`
      INSERT INTO recurring_expenses
      (user_id, amount, category_id, note, day_of_month, start_month)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(action.userId, action.amount, action.categoryId,
      action.note, action.dayOfMonth, action.startMonth);
    return `Recurring expense #${result.lastInsertRowid} created: ` +
      `${money(action.amount)} (${action.category}) monthly from ${action.startMonth}. ` +
      `It will be posted automatically when PaisaPal starts on or after its due date.`;
  }

  if (action.kind === 'recurring_cancel') {
    const result = db.prepare(`
      UPDATE recurring_expenses SET active = 0
      WHERE recurring_id = ? AND user_id = ? AND active = 1
    `).run(action.recurringId, action.userId);
    return result.changes ? `Recurring expense #${action.recurringId} stopped.`
      : 'Active recurring expense no longer exists.';
  }

  if (action.kind === "batch") {
    const insert = db.prepare(`
      INSERT INTO transactions
      (user_id, amount, type, category_id, note, txn_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const savedIds = [];

    db.exec("BEGIN IMMEDIATE");

    try {
      for (const item of action.transactions) {
        const result = insert.run(
          action.userId,
          item.amount,
          item.type,
          item.categoryId,
          item.note,
          item.date
        );

        savedIds.push(Number(result.lastInsertRowid));
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return `Saved ${savedIds.length} transactions: ${savedIds.join(", ")}.`;
  }



  if (action.kind === "add") {
    const result = db.prepare(`
      INSERT INTO transactions
      (user_id, amount, type, category_id, note, txn_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      action.userId,
      action.amount,
      action.type,
      action.categoryId,
      action.note,
      action.date
    );

    let message =
      `Saved transaction #${result.lastInsertRowid}: ` +
      `${money(action.amount)} (${action.category}).`;

    if (action.type === "EXPENSE") {
      const month = action.date.slice(0, 7);
      const statuses = getBudgetStatuses(
        action.userId,
        month
      );

      const budget = statuses.find(
        item => item.category === action.category
      );

      if (budget?.status === "OVER_BUDGET") {
        message +=
          ` ALERT: ${action.category} is over budget ` +
          `at ${budget.percentage}%.`;
      } else if (budget?.status === "WARNING") {
        message +=
          ` WARNING: ${action.category} spending has ` +
          `reached ${budget.percentage}% of the budget.`;
      }
    }

    return message;
  }

  if (action.kind === "budget") {
    db.prepare(`
      INSERT INTO budgets
      (user_id, category_id, month, limit_amount)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, category_id, month)
      DO UPDATE SET limit_amount = excluded.limit_amount
    `).run(
      action.userId,
      action.categoryId,
      action.month,
      action.limitAmount
    );

    const budget = getBudgetStatuses(
      action.userId,
      action.month
    ).find(item => item.category === action.category);

    let message =
      `${action.category} budget set to ` +
      `${money(action.limitAmount)} for ${action.month}.`;

    if (budget?.status === "OVER_BUDGET") {
      message += ` ALERT: Already ${budget.percentage}% spent.`;
    } else if (budget?.status === "WARNING") {
      message += ` WARNING: Already ${budget.percentage}% spent.`;
    }

    return message;
  }

  if (action.kind === "delete") {
    const result = db.prepare(`
      DELETE FROM transactions
      WHERE txn_id = ?
        AND user_id = ?
    `).run(
      action.transactionId,
      action.userId
    );

    if (result.changes === 0) {
      return "Transaction no longer exists.";
    }

    return `Deleted transaction #${action.transactionId}.`;
  }

  throw new Error("Unknown operation.");
}

const addMultipleTransactionsTool = tool(
  async ({ transactions }) => {
    try {
      const prepared = [];

      for (const item of transactions) {
        if (!validDate(item.date)) {
          return `Invalid date: ${item.date}`;
        }

        const id = categoryId(item.category);

        prepared.push({
          userId: currentUserId,
          amount: item.amount,
          type: item.type,
          categoryId: id,
          category: item.category,
          note: item.note,
          date: item.date
        });
      }

      const lines = prepared.map((item, index) => {
        return `${index + 1}. ${money(item.amount)} ` +
          `${item.category} on ${item.date} (${item.note})`;
      });

      return prepareAction({
        kind: "batch",
        userId: currentUserId,
        transactions: prepared,
        description:
          `Save these ${prepared.length} transactions?\n` +
          lines.join("\n")
      });
    } catch (error) {
      return error.message;
    }
  },
  {
    name: "add_multiple_transactions",
    description:
      "Prepare two or more income or expense transactions " +
      "from one user message. Do not save until confirmation. " +
      "Use Travel for auto-rickshaw or taxi expenses.",
    schema: z.object({
      transactions: z.array(
        z.object({
          amount: z.number().positive(),
          type: z.enum(["INCOME", "EXPENSE"]),
          category: z.string().trim().min(1),
          note: z.string().default(""),
          date: z.string()
        })
      ).min(2)
    })
  }
);




export function setupRecurringExpenses() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_expenses (
      recurring_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      category_id INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
      start_month TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(user_id),
      FOREIGN KEY (category_id) REFERENCES categories(category_id)
    );
    CREATE TABLE IF NOT EXISTS recurring_postings (
      recurring_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      txn_id INTEGER NOT NULL,
      PRIMARY KEY (recurring_id, month),
      FOREIGN KEY (recurring_id) REFERENCES recurring_expenses(recurring_id),
      FOREIGN KEY (txn_id) REFERENCES transactions(txn_id)
    );
  `);
}

function nextMonth(month) {
  const [year, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, m, 1));
  return date.toISOString().slice(0, 7);
}

function dueDate(month, day) {
  const [year, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}


export function processRecurringExpenses() {
  setupRecurringExpenses();
  const today = todayInIndia();
  const currentMonth = today.slice(0, 7);
  const rules = runQuery(`
    SELECT recurring_id, user_id, amount, category_id,
           note, day_of_month, start_month
    FROM recurring_expenses
    WHERE active = 1 AND user_id = ?
  `, [currentUserId]);

  const added = [];
  const insert = db.prepare(`
    INSERT INTO transactions
    (user_id, amount, type, category_id, note, txn_date)
    VALUES (?, ?, 'EXPENSE', ?, ?, ?)
  `);
  const record = db.prepare(`
    INSERT INTO recurring_postings (recurring_id, month, txn_id)
    VALUES (?, ?, ?)
  `);
  const exists = db.prepare(`
    SELECT 1 FROM recurring_postings WHERE recurring_id = ? AND month = ?
  `);

  for (const rule of rules) {
    let month = rule.start_month;
    let count = 0;
    // Safety limit: at most 120 monthly periods per rule per launch.
    while (month <= currentMonth && count < 120) {
      const date = dueDate(month, rule.day_of_month);
      if (date <= today && !exists.get(rule.recurring_id, month)) {
        db.exec('BEGIN IMMEDIATE');
        try {
          // Check again within the transaction.
          if (!exists.get(rule.recurring_id, month)) {
            const result = insert.run(rule.user_id, rule.amount,
              rule.category_id, `[Recurring] ${rule.note}`, date);
            record.run(rule.recurring_id, month, Number(result.lastInsertRowid));
            added.push({ amount: rule.amount, note: rule.note, date });
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      month = nextMonth(month);
      count++;
    }
  }
  return added;
}

const addRecurringExpenseTool = tool(
  async ({ amount, category, note, dayOfMonth }) => {
    try {
      const id = categoryId(category);
  
      const startMonth = nextMonth(todayInIndia().slice(0, 7));
      return prepareAction({
        kind: 'recurring_add', userId: currentUserId,
        amount, categoryId: id, category, note, dayOfMonth, startMonth,
        description: `Create monthly recurring expense ${money(amount)} ` +
          `for ${category} (${note}) on day ${dayOfMonth}, ` +
          `starting ${startMonth}?`
      });
    } catch (error) {
      return error.message;
    }
  },
  {
    name: 'add_recurring_expense',
    description: 'Set up automatic monthly expense for rent, subscriptions, etc. ' +
      'Requires amount, category, description and day of month (1-31). ' +
      'Starts NEXT month; requires yes/no confirmation.',
    schema: z.object({
      amount: z.number().positive(),
      category: z.string().trim().min(1),
      note: z.string().trim().min(1),
      dayOfMonth: z.number().int().min(1).max(31)
    })
  }
);

const listRecurringExpensesTool = tool(
  async () => JSON.stringify(runQuery(`
    SELECT r.recurring_id, r.amount, c.name AS category, r.note,
           r.day_of_month, r.start_month, r.active
    FROM recurring_expenses r
    JOIN categories c ON c.category_id = r.category_id
    WHERE r.user_id = ? ORDER BY r.recurring_id
  `, [currentUserId])),
  {
    name: 'list_recurring_expenses',
    description: 'Show monthly recurring expenses and their IDs.',
    schema: z.object({})
  }
);

const cancelRecurringExpenseTool = tool(
  async ({ recurringId }) => {
    const rule = getOne(`
      SELECT r.recurring_id, r.amount, r.note, c.name AS category
      FROM recurring_expenses r
      JOIN categories c ON c.category_id = r.category_id
      WHERE r.recurring_id = ? AND r.user_id = ? AND r.active = 1
    `, [recurringId, currentUserId]);
    if (!rule) return 'Active recurring expense not found for this user.';
    return prepareAction({
      kind: 'recurring_cancel', userId: currentUserId, recurringId,
      description: `Stop monthly ${money(rule.amount)} ${rule.category} ` +
        `(${rule.note}) recurring expense #${recurringId}? ` +
        `Previously saved transactions will remain.`
    });
  },
  {
    name: 'cancel_recurring_expense',
    description: 'Stop a recurring expense after user confirmation; does not delete past transactions.',
    schema: z.object({ recurringId: z.number().int().positive() })
  }
);

export const tools = [
  addTransactionTool,
  listTransactionsTool,
  spendingSummaryTool,
  setBudgetTool,
  checkBudgetTool,
  deleteTransactionTool,
  addMultipleTransactionsTool,
  addRecurringExpenseTool,
  listRecurringExpensesTool,
  cancelRecurringExpenseTool
];

