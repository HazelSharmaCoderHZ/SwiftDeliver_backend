const express = require("express");
const router = express.Router();
const connectDB = require("../db");
const verifyToken = require("../middleware/authMiddleware");

const VALID_STATUSES = [
  "Created",
  "Assigned",
  "Picked Up",
  "In Transit",
  "Out for Delivery",
  "Delivered",
];

// Status order for validation (prevent going backwards)
const STATUS_ORDER = {
  "Created": 0,
  "Assigned": 1,
  "Picked Up": 2,
  "In Transit": 3,
  "Out for Delivery": 4,
  "Delivered": 5,
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/status  — Agent updates delivery status
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", verifyToken, async (req, res) => {
  let connection;
  try {
    if (req.user.role !== "agent") {
      return res.status(403).json({ message: "Only agents can update status" });
    }

    const { consignment_id, status_name, location } = req.body;

    if (!consignment_id || !status_name) {
      return res.status(400).json({ message: "consignment_id and status_name are required" });
    }

    if (!VALID_STATUSES.includes(status_name)) {
      return res.status(400).json({
        message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    connection = await connectDB();

    // ── Verify this consignment belongs to this agent ────────────────────────
    const check = await connection.execute(
      `SELECT current_status FROM consignment WHERE consignment_id = :id AND agent_id = :agent`,
      { id: consignment_id, agent: req.user.id }
    );

    if (check.rows.length === 0) {
      return res.status(403).json({ message: "Consignment not found or not assigned to you" });
    }

    const currentStatus = check.rows[0][0];

    // ── Prevent going backward in status ────────────────────────────────────
    if (STATUS_ORDER[status_name] <= STATUS_ORDER[currentStatus]) {
      return res.status(400).json({
        message: `Cannot set status to '${status_name}' — current status is '${currentStatus}'`,
      });
    }

    // ── Insert status record ─────────────────────────────────────────────────
    await connection.execute(
      `INSERT INTO status (consignment_id, status_name, status_time, location, updated_by)
       VALUES (:id, :status, SYSTIMESTAMP, :location, :user_id)`,
      {
        id: consignment_id,
        status: status_name,
        location: location || null,
        user_id: req.user.id,
      }
    );

    // ── Update consignment current_status ────────────────────────────────────
    await connection.execute(
      `UPDATE consignment SET current_status = :status WHERE consignment_id = :id`,
      { status: status_name, id: consignment_id }
    );

    await connection.commit();

    res.json({ message: `Status updated to '${status_name}'` });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/status/:consignment_id  — Full timeline for a consignment
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:consignment_id", verifyToken, async (req, res) => {
  let connection;
  try {
    const { consignment_id } = req.params;

    connection = await connectDB();

    const result = await connection.execute(
      `SELECT s.status_name, s.status_time, s.location,
              CASE
                WHEN s.updated_by IN (SELECT customer_id FROM customer) THEN 'Customer'
                ELSE 'Agent'
              END AS updated_by_role
       FROM status s
       WHERE s.consignment_id = :id
       ORDER BY s.status_time ASC`,
      { id: consignment_id }
    );

    const columns = result.metaData.map((c) => c.name);
    const data = result.rows.map((row) => {
      const obj = {};
      columns.forEach((col, i) => (obj[col] = row[i]));
      return obj;
    });

    res.json(data);
  } catch (err) {
    console.error("GET STATUS HISTORY ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

module.exports = router;