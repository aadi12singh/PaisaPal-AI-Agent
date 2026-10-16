import "dotenv/config";
import { ChatGroq } from "@langchain/groq";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import * as readline from "node:readline/promises";
import {stdin as input,stdout as output} from "node:process";
import db from "./database/db.js";
import { tools, todayInIndia, getPendingAction, clearPendingAction, executeConfirmedAction, setupRecurringExpenses, processRecurringExpenses } from "./tools.js";

const rl = readline.createInterface({ input, output });
const memory = new MemorySaver();

const model = new ChatGroq({
  apiKey: process.env.GROQ_API_KEY,
  model: "openai/gpt-oss-120b"
});

const agent = createAgent({
  model,
  tools,
  checkpointer: memory,

  systemPrompt: `
You are PaisaPal, a helpful personal expense and budget agent.
Your name is PaisaPal. Introduce yourself by name.
Today in India is ${todayInIndia()}.
Use Asia/Kolkata for relative dates.
Convert dates like today, yesterday and last Monday
to YYYY-MM-DD before calling a tool.
The current user is Rahul (user ID 1).
Never ask the model to choose a different user ID.
Use SQLite tools for financial questions.
Never invent transactions, budgets or totals.
For add_transaction, ask for missing amount,
category, type or date instead of guessing.
For an expense, type is EXPENSE.
For income, type is INCOME.
When the user mentions two or more transactions
in one message, use add_multiple_transactions.
Do not use add_transaction separately for them.
Use Travel as the category for auto-rickshaw,
taxi, bus and cab expenses.
Ask for one yes/no confirmation for the whole batch.
Never claim transactions are saved before confirmation.
When the user asks to save an expense,
use add_transaction to prepare it.
When the user asks to change a budget,
use set_budget to prepare it.
When the user asks to delete a transaction,
use delete_transaction to prepare it.
These tools do not save or delete immediately.
They return a confirmation request.
Tell the user to reply yes or no.
Never say an operation succeeded until
the application confirms that it succeeded.
Use get_spending_summary for monthly totals.
For comparisons, call it for both months.
Calculate the difference using actual results.
Give three practical saving tips based on the data.
Use check_budget_status to identify warnings
and over-budget categories.
For monthly rent, subscriptions or other repeating expenses,
use add_recurring_expense. Ask for missing amount, category,
description or day of month instead of guessing.
Recurring rules start next month and are posted when the app starts
on or after the due date. Do not claim they run while the app is closed.
Use list_recurring_expenses to show rules and cancel_recurring_expense
to stop a rule after confirmation.
Keep responses simple, clear and friendly.
`
});


async function startChat() {
  setupRecurringExpenses();
  try {
    const posted = processRecurringExpenses();
    if (posted.length) {
      console.log(`PaisaPal: Automatically added ${posted.length} due recurring expense(s):`);
      for (const item of posted) {
        console.log(`  ₹${Number(item.amount).toFixed(2)} - ${item.note} (${item.date})`);
      }
    }
  } catch (error) {
    console.log('PaisaPal: Could not process recurring expenses:', error.message);
  }

  console.log("\nWelcome to PaisaPal!");
  console.log("Your personal expense and budget assistant.");
  console.log("Type bye to exit.\n");

  try {
    while (true) {
      const inputText = await rl.question("Enter your message: ");
      const message = inputText.trim();

      if (message.toLowerCase() === "bye") {
        console.log("PaisaPal: Goodbye!");
        break;
      }

      if (!message) {
        continue;
      }


      if (getPendingAction()) {
        const answer = message.toLowerCase();

        if (answer === "yes") {
          const action = getPendingAction();
          clearPendingAction();

          try {
            const result = executeConfirmedAction(action);
            console.log("PaisaPal:", result);
          } catch (error) {
            console.log("PaisaPal: Operation failed:", error.message);
          }

          continue;
        }

        if (answer === "no") {
          clearPendingAction();
          console.log("PaisaPal: Operation cancelled.");
          continue;
        }

        console.log(
          "PaisaPal: Please reply yes or no first."
        );
        continue;
      }

      try {
        const response = await agent.invoke(
          {
            messages: [
              {
                role: "user",
                content: message
              }
            ]
          },
          {
            configurable: {
              thread_id: "paisapal-user-1"
            }
          }
        );

        const lastMessage = response.messages.at(-1);

        console.log("PaisaPal:", lastMessage.content);


        if (getPendingAction()) {
          console.log(
            "\nPaisaPal: " +
            getPendingAction().description +
            " (yes/no)"
          );
        }

        console.log();
      } catch (error) {
        console.log("PaisaPal error:", error.message);
      }
    }
  } finally {
    rl.close();
    db.close();
  }
}

startChat().catch(error => {
  console.error("Application error:", error.message);
  process.exitCode = 1;
});


