const express = require("express");
const router = express.Router();
const connectDB = require("../db");
const verifyToken = require("../middleware/authMiddleware");
const oracledb = require("oracledb");

const VALID_METHODS = ["Cash", "Card", "UPI", "Net Banking", "Wallet"];
const VALID_PAYMENT_STATUSES = ["Pending", "Paid", "Failed", "Refunded"];

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments  — Customer makes a payment for a consignment
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", verifyToken, async (req, res) => {
  let connection;
  try {
    if (!req.user.role.toLowerCase().includes("customer")) {
      return res.status(403).json({ message: "Only customers can make payments" });
    }

    const { consignment_id, payment_method, amount } = req.body;

    if (!consignment_id || !payment_method || !amount) {
      return res.status(400).json({ message: "consignment_id, payment_method, and amount are required" });
    }

    if (!VALID_METHODS.includes(payment_method)) {
      return res.status(400).json({ message: `Invalid payment method. Use: ${VALID_METHODS.join(", ")}` });
    }

    if (isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ message: "Amount must be a positive number" });
    }

    connection = await connectDB();

    // ── Verify this consignment belongs to this customer ─────────────────────
    const check = await connection.execute(
      `SELECT consignment_id FROM consignment WHERE consignment_id = :id AND customer_id = :cust`,
      { id: consignment_id, cust: req.user.id }
    );

    if (check.rows.length === 0) {
      return res.status(403).json({ message: "Consignment not found or not yours" });
    }

    // ── Check if already fully paid ──────────────────────────────────────────
    const existingPaid = await connection.execute(
      `SELECT SUM(amount) FROM payment WHERE consignment_id = :id AND payment_status = 'Paid'`,
      { id: consignment_id }
    );

    const paidAmount = existingPaid.rows[0][0] || 0;

    const insertResult = await connection.execute(
      `INSERT INTO payment (consignment_id, payment_method, amount, payment_status, payment_date)
       VALUES (:consignment_id, :method, :amount, 'Paid', SYSDATE)
       RETURNING payment_id INTO :new_id`,
      {
        consignment_id,
        method: payment_method,
        amount: Number(amount),
        new_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    await connection.commit();

    const paymentId = insertResult.outBinds.new_id[0];

    res.json({
      message: "Payment successful",
      paymentId,
      amount: Number(amount),
      payment_method,
      payment_status: "Paid",
    });
  } catch (err) {
    console.error("PAYMENT ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/consignment/:consignment_id  — Payment history for a consignment
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
    const data = result.rows.map((row) => {
      const obj = {};
      columns.forEach((col, i) => (obj[col] = row[i]));
      return obj;
    });

    const total = data
      .filter((p) => p.PAYMENT_STATUS === "Paid")
      .reduce((sum, p) => sum + Number(p.AMOUNT), 0);

    res.json({ payments: data, totalPaid: total });
  } catch (err) {
    console.error("GET PAYMENTS ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/my  — All payments by logged-in customer
// ─────────────────────────────────────────────────────────────────────────────
router.get("/my", verifyToken, async (req, res) => {
  let connection;
  try {
    if (!req.user.role.toLowerCase().includes("customer")) {
      return res.status(403).json({ message: "Only customers allowed" });
    }

    connection = await connectDB();

    const result = await connection.execute(
      `SELECT p.payment_id, p.consignment_id, p.payment_method, p.amount, p.payment_status, p.payment_date,
              c.item_details, c.current_status
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

    res.json(data);
  } catch (err) {
    console.error("GET MY PAYMENTS ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

module.exports = router;