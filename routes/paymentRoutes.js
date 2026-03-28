const express = require("express");
const router = express.Router();
const connectDB = require("../db");
const verifyToken = require("../middleware/authMiddleware");

const VALID_METHODS = ["Cash", "Card", "UPI", "Net Banking", "Wallet"];

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/my  — All payments by logged-in customer (history page)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/my", verifyToken, async (req, res) => {
  let connection;
  try {
    if (!req.user.role.toLowerCase().includes("customer")) {
      return res.status(403).json({ message: "Only customers allowed" });
    }

    connection = await connectDB();

    const result = await connection.execute(
      `SELECT
         p.payment_id,
         p.consignment_id,
         p.payment_method,
         p.amount,
         p.payment_status,
         p.payment_date,
         c.item_details,
         c.current_status,
         c.weight
       FROM payment p
       JOIN consignment c ON p.consignment_id = c.consignment_id
       WHERE c.customer_id = :id
       ORDER BY p.payment_date DESC`,
      { id: req.user.id }
    );

    const columns = result.metaData.map((c) => c.name);
    const data = await Promise.all(
      result.rows.map(async (row) => {
        const obj = {};
        for (let i = 0; i < columns.length; i++) {
          let val = row[i];
          if (val && typeof val === "object" && typeof val.getData === "function") {
            val = await val.getData();
          }
          obj[columns[i]] = val;
        }
        return obj;
      })
    );

    const totalSpent = data
      .filter((p) => (p.PAYMENT_STATUS || p.payment_status) === "Paid")
      .reduce((sum, p) => sum + Number(p.AMOUNT || p.amount || 0), 0);

    res.json({ payments: data, totalSpent });
  } catch (err) {
    console.error("GET MY PAYMENTS ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/consignment/:consignment_id  — Payments for one consignment
// ─────────────────────────────────────────────────────────────────────────────
router.get("/consignment/:consignment_id", verifyToken, async (req, res) => {
  let connection;
  try {
    const { consignment_id } = req.params;
    connection = await connectDB();

    const result = await connection.execute(
      `SELECT payment_id, consignment_id, payment_method, amount, payment_status, payment_date
       FROM payment
       WHERE consignment_id = :id
       ORDER BY payment_date DESC`,
      { id: consignment_id }
    );

    const columns = result.metaData.map((c) => c.name);
    const payments = result.rows.map((row) => {
      const obj = {};
      columns.forEach((col, i) => (obj[col] = row[i]));
      return obj;
    });

    const totalPaid = payments
      .filter((p) => p.PAYMENT_STATUS === "Paid")
      .reduce((sum, p) => sum + Number(p.AMOUNT || 0), 0);

    res.json({ payments, totalPaid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

module.exports = router;