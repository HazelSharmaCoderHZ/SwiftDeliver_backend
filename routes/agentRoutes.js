const express = require("express");
const router = express.Router();
const oracledb = require("oracledb");
const connectDB = require("../db");
const verifyToken = require("../middleware/authMiddleware");
const checkRole = require("../middleware/roleMiddleware");

// 🔥 GET ALL AGENTS (only agents allowed)
router.get("/", verifyToken, checkRole("agent"), async (req, res) => {
  let connection;

  try {
    connection = await connectDB();

    const result = await connection.execute("SELECT * FROM DELIVERYAGENT");

    res.json(result.rows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

module.exports = router;