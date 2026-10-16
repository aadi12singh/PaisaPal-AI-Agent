
CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    monthly_income REAL NOT NULL DEFAULT 0
        CHECK (monthly_income >= 0)
);

CREATE TABLE IF NOT EXISTS categories (
    category_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS transactions (
    txn_id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    type TEXT NOT NULL
        CHECK (type IN ('INCOME', 'EXPENSE')),
    category_id INTEGER NOT NULL,
    note TEXT,
    txn_date TEXT NOT NULL,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id),

    FOREIGN KEY (category_id)
        REFERENCES categories(category_id)
);

CREATE TABLE IF NOT EXISTS budgets (
    budget_id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    month TEXT NOT NULL,
    limit_amount REAL NOT NULL
        CHECK (limit_amount > 0),

    FOREIGN KEY (user_id)
        REFERENCES users(user_id),

    FOREIGN KEY (category_id)
        REFERENCES categories(category_id),

    UNIQUE (user_id, category_id, month)
);
