const express = require("express");
const router = express.Router();
const connectDB = require("../db");
const verifyToken = require("../middleware/authMiddleware");
const oracledb = require("oracledb");

// ─── HELPER: Convert raw Oracle rows to objects (handles CLOB) ───────────────
async function rowsToObjects(rows, metaData) {
  const columns = metaData.map((col) => col.name);
  return Promise.all(
    rows.map(async (row) => {
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
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /consignments/my  — Customer: view own consignments + agent + vehicle
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
         c.consignment_id,
         c.item_details,
         c.weight,
         c.dimensions,
         c.current_status,
         c.booking_date,
         d.name         AS agent_name,
         d.phone_number AS agent_phone,
         d.availability_status,
         v.vehicle_number,
         v.vehicle_type,
         v.capacity
       FROM consignment c
       LEFT JOIN deliveryagent d ON c.agent_id = d.agent_id
       LEFT JOIN vehicle v ON c.vehicle_id = v.vehicle_id
       WHERE c.customer_id = :id
       ORDER BY c.booking_date DESC`,
      { id: req.user.id }
    );

    const data = await rowsToObjects(result.rows, result.metaData);
    res.json(data);
  } catch (err) {
    console.error("GET /my ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /consignments  — Customer: create consignment (auto-assign agent + vehicle)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", verifyToken, async (req, res) => {
  let connection;
  try {
    if (!req.user.role.toLowerCase().includes("customer")) {
      return res.status(403).json({ message: "Only customers can create consignments" });
    }

    const { item_details, weight, dimensions } = req.body;

    if (!item_details || !weight) {
      return res.status(400).json({ message: "Item details and weight are required" });
    }

    connection = await connectDB();

    // ── Auto-assign vehicle: best fit by capacity ────────────────────────────
    let vehicleResult = await connection.execute(
      `SELECT vehicle_id FROM vehicle
       WHERE capacity >= :weight
       ORDER BY capacity ASC
       FETCH FIRST 1 ROWS ONLY`,
      { weight: Number(weight) }
    );

    if (vehicleResult.rows.length === 0) {
      // fallback: largest available vehicle
      vehicleResult = await connection.execute(
        `SELECT vehicle_id FROM vehicle ORDER BY capacity DESC FETCH FIRST 1 ROWS ONLY`
      );
    }

    if (vehicleResult.rows.length === 0) {
      return res.status(400).json({ message: "No vehicles available" });
    }

    const vehicleId = vehicleResult.rows[0][0];

    // ── Auto-assign agent: least active workload ─────────────────────────────
    const agentResult = await connection.execute(
      `SELECT agent_id FROM (
         SELECT a.agent_id, COUNT(c.consignment_id) AS workload
         FROM deliveryagent a
         LEFT JOIN consignment c
           ON a.agent_id = c.agent_id
           AND c.current_status NOT IN ('Delivered', 'Cancelled')
         GROUP BY a.agent_id
         ORDER BY workload ASC
       ) WHERE ROWNUM = 1`
    );

    if (agentResult.rows.length === 0) {
      return res.status(400).json({ message: "No delivery agents available" });
    }

    const agentId = agentResult.rows[0][0];

    // ── Insert consignment ───────────────────────────────────────────────────
    const insertResult = await connection.execute(
      `INSERT INTO consignment
         (customer_id, item_details, weight, dimensions, current_status, agent_id, vehicle_id, booking_date)
       VALUES
         (:customer_id, :item_details, :weight, :dimensions, :current_status, :agent_id, :vehicle_id, SYSDATE)
       RETURNING consignment_id INTO :new_id`,
      {
        customer_id: req.user.id,
        item_details,
        weight: Number(weight),
        dimensions: dimensions || null,
        current_status: "Created",
        agent_id: agentId,
        vehicle_id: vehicleId,
        new_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    const consignmentId = insertResult.outBinds.new_id[0];

    // ── Initial status records ───────────────────────────────────────────────
    await connection.execute(
      `INSERT INTO status (consignment_id, status_name, status_time, location, updated_by)
       VALUES (:id, 'Created', SYSTIMESTAMP, 'Warehouse', :user_id)`,
      { id: consignmentId, user_id: req.user.id }
    );

    await connection.execute(
      `INSERT INTO status (consignment_id, status_name, status_time, location, updated_by)
       VALUES (:id, 'Assigned', SYSTIMESTAMP, 'Warehouse', :agent_id)`,
      { id: consignmentId, agent_id: agentId }
    );

    await connection.commit();

    res.json({
      message: "Consignment created and agent assigned automatically",
      consignmentId,
      assignedAgent: agentId,
      assignedVehicle: vehicleId,
    });
  } catch (err) {
    console.error("CREATE CONSIGNMENT ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /consignments/agent  — Agent: to-deliver + delivered + stats
// ─────────────────────────────────────────────────────────────────────────────
router.get("/agent", verifyToken, async (req, res) => {
  let connection;
  try {
    if (!req.user.role.toLowerCase().includes("agent")) {
      return res.status(403).json({ message: "Only agents allowed" });
    }

    connection = await connectDB();

    const result = await connection.execute(
      `SELECT
         c.consignment_id,
         c.item_details,
         c.weight,
         c.dimensions,
         c.current_status,
         c.booking_date,
         cu.name       AS customer_name,
         cu.phone_number AS customer_phone,
         cu.pickup_address,
         cu.delivery_address,
         v.vehicle_number,
         v.vehicle_type
       FROM consignment c
       LEFT JOIN customer cu ON c.customer_id = cu.customer_id
       LEFT JOIN vehicle v ON c.vehicle_id = v.vehicle_id
       WHERE c.agent_id = :id
       ORDER BY c.booking_date DESC`,
      { id: req.user.id }
    );

    const data = await rowsToObjects(result.rows, result.metaData);

    const toDeliver = data.filter((c) => c.CURRENT_STATUS !== "Delivered");
    const delivered = data.filter((c) => c.CURRENT_STATUS === "Delivered");

    // ── Agent profile ────────────────────────────────────────────────────────
    const agentResult = await connection.execute(
      `SELECT name, phone_number, availability_status FROM deliveryagent WHERE agent_id = :id`,
      { id: req.user.id }
    );

    const agentRow = agentResult.rows[0] || [];
    const agent = {
      name: agentRow[0],
      phone: agentRow[1],
      availability: agentRow[2],
    };

    res.json({ toDeliver, delivered, agent });
  } catch (err) {
    console.error("GET /agent ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /consignments/:id  — Get single consignment detail (customer or agent)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", verifyToken, async (req, res) => {
  let connection;
  try {
    connection = await connectDB();

    const result = await connection.execute(
      `SELECT
         c.consignment_id,
         c.item_details,
         c.weight,
         c.dimensions,
         c.current_status,
         c.booking_date,
         d.agent_id,
         d.name         AS agent_name,
         d.phone_number AS agent_phone,
         d.availability_status,
         v.vehicle_number,
         v.vehicle_type,
         v.capacity
       FROM consignment c
       LEFT JOIN deliveryagent d ON c.agent_id = d.agent_id
       LEFT JOIN vehicle v ON c.vehicle_id = v.vehicle_id
       WHERE c.consignment_id = :id`,
      { id: req.params.id }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Consignment not found" });
    }

    const data = await rowsToObjects(result.rows, result.metaData);
    res.json(data[0]);
  } catch (err) {
    console.error("GET /:id ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

module.exports = router;