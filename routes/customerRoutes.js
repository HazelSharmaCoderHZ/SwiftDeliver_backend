const express = require("express");
const router = express.Router();
const oracledb = require("oracledb");
const connectDB = require("../db");
const verifyToken = require("../middleware/authMiddleware");
const bcrypt = require("bcryptjs");
const checkRole = require("../middleware/roleMiddleware");

// ✅ GET ALL CUSTOMERS (PROTECTED 🔐)
router.get("/", verifyToken, async (req, res) => {
  let connection;

  try {
    connection = await connectDB();

    const result = await connection.execute("SELECT * FROM CUSTOMER");

    const columns = result.metaData.map(col => col.name);

    const data = await Promise.all(result.rows.map(async (row) => {
      let obj = {};

      for (let i = 0; i < columns.length; i++) {
        let value = row[i];

        // handle CLOB
        if (value && typeof value === "object" && value.getData) {
          value = await value.getData();
        }

        obj[columns[i]] = value;
      }

      return obj;
    }));

    res.json(data);

  } catch (err) {
    console.error("ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close(); // 🔥 important
  }
});

router.put("/:id", async (req, res) => {
  let connection;

  try {
    const { id } = req.params;
    const { name, phone_number } = req.body;

    connection = await connectDB();

    await connection.execute(
      `UPDATE CUSTOMER 
       SET name = :name, phone_number = :phone
       WHERE customer_id = :id`,
      {
        name,
        phone: phone_number,
        id
      },
      { autoCommit: true }
    );

    res.json({ message: "Customer updated successfully" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// ✅ POST CUSTOMER (SECURE PASSWORD 🔐)
router.post("/", async (req, res) => {
  let connection;

  try {
    const { name, email, password, phone_number, pickup_address, delivery_address } = req.body;

    connection = await connectDB();

    // 🔍 Check if email exists
    const existing = await connection.execute(
      `SELECT * FROM CUSTOMER WHERE email = :email`,
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ message: "User already exists" });
    }

    // 🔐 Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    await connection.execute(
      `INSERT INTO CUSTOMER 
       (name, email, password, phone_number, pickup_address, delivery_address)
       VALUES (:name, :email, :password, :phone, :pickup, :delivery)`,

      {
        name,
        email,
        password: hashedPassword,
        phone: phone_number,
        pickup: pickup_address,
        delivery: delivery_address
      },
      { autoCommit: true }
    );

    res.json({ message: "Customer added successfully" });

  } catch (err) {
    console.error("ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close(); // 🔥 important
  }
});
router.delete("/:id", async (req, res) => {
  let connection;

  try {
    const { id } = req.params;

    connection = await connectDB();

    await connection.execute(
      `DELETE FROM CUSTOMER WHERE customer_id = :id`,
      [id],
      { autoCommit: true }
    );

    res.json({ message: "Customer deleted successfully" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});
router.get("/agent-only", verifyToken, checkRole("agent"), (req, res) => {
  res.json({ message: "Welcome agent 🚚" });
});
module.exports = router;