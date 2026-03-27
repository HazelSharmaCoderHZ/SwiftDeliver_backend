const express = require("express");
const router = express.Router();
const connectDB = require("../db");
const verifyToken = require("../middleware/authMiddleware");
const oracledb = require("oracledb");

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles  — List all vehicles (agents + customers can view)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", verifyToken, async (req, res) => {
  let connection;
  try {
    connection = await connectDB();

    const result = await connection.execute(
      `SELECT vehicle_id, vehicle_number, vehicle_type, capacity FROM vehicle ORDER BY vehicle_type`
    );

    const columns = result.metaData.map((c) => c.name);
    const data = result.rows.map((row) => {
      const obj = {};
      columns.forEach((col, i) => (obj[col] = row[i]));
      return obj;
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vehicles  — Add vehicle (agent only)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", verifyToken, async (req, res) => {
  let connection;
  try {
    if (!req.user.role.toLowerCase().includes("agent")) {
      return res.status(403).json({ message: "Only agents can add vehicles" });
    }

    const { vehicle_number, vehicle_type, capacity } = req.body;

    if (!vehicle_number || !vehicle_type || !capacity) {
      return res.status(400).json({ message: "All fields are required" });
    }

    connection = await connectDB();

    const existing = await connection.execute(
      `SELECT vehicle_id FROM vehicle WHERE vehicle_number = :num`,
      { num: vehicle_number }
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ message: "Vehicle already registered" });
    }

    const insertResult = await connection.execute(
      `INSERT INTO vehicle (vehicle_number, vehicle_type, capacity)
       VALUES (:num, :type, :cap)
       RETURNING vehicle_id INTO :new_id`,
      {
        num: vehicle_number,
        type: vehicle_type,
        cap: Number(capacity),
        new_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    await connection.commit();

    res.json({
      message: "Vehicle added",
      vehicleId: insertResult.outBinds.new_id[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

module.exports = router;