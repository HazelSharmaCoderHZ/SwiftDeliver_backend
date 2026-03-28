const express = require("express");
const router = express.Router();
const connectDB = require("../db");
const verifyToken = require("../middleware/authMiddleware");
const oracledb = require("oracledb");

// ─── HELPER: Oracle rows → objects (handles CLOB) ────────────────────────────
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
// POST /consignments/quote  — Preview fare before creating (weight * ₹20)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/quote", verifyToken, async (req, res) => {
  try {
    if (!req.user.role.toLowerCase().includes("customer")) {
      return res.status(403).json({ message: "Only customers allowed" });
    }
    const { weight } = req.body;
    if (!weight || isNaN(weight) || Number(weight) <= 0) {
      return res.status(400).json({ message: "Valid weight required" });
    }
    const fare = Math.ceil(Number(weight) * 20);
    res.json({ fare, weight: Number(weight) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /consignments/my  — Customer: own consignments with all details
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
         d.name            AS agent_name,
         d.phone_number    AS agent_phone,
         d.availability_status,
         v.vehicle_number,
         v.vehicle_type,
         v.capacity,
         NVL((SELECT SUM(p2.amount) FROM payment p2
              WHERE p2.consignment_id = c.consignment_id
              AND p2.payment_status = 'Paid'), 0) AS amount_paid,
         (SELECT p3.payment_method FROM payment p3
          WHERE p3.consignment_id = c.consignment_id
          AND ROWNUM = 1) AS payment_method
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
// POST /consignments  — Create consignment + auto-assign + insert payment
// Payment is required upfront. Fare = weight * 20.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", verifyToken, async (req, res) => {
  let connection;
  try {
    if (!req.user.role.toLowerCase().includes("customer")) {
      return res.status(403).json({ message: "Only customers can create consignments" });
    }

    const { item_details, weight, dimensions, payment_method } = req.body;

    if (!item_details || !weight) {
      return res.status(400).json({ message: "Item details and weight are required" });
    }
    if (!payment_method) {
      return res.status(400).json({ message: "Payment method is required to place a consignment" });
    }

    const fare = Math.ceil(Number(weight) * 20);

    connection = await connectDB();

    // ── Best-fit vehicle by capacity ──────────────────────────────────────────
    let vehicleResult = await connection.execute(
      `SELECT vehicle_id FROM vehicle
       WHERE capacity >= :weight
       ORDER BY capacity ASC
       FETCH FIRST 1 ROWS ONLY`,
      { weight: Number(weight) }
    );
    if (vehicleResult.rows.length === 0) {
      vehicleResult = await connection.execute(
        `SELECT vehicle_id FROM vehicle ORDER BY capacity DESC FETCH FIRST 1 ROWS ONLY`
      );
    }
    if (vehicleResult.rows.length === 0) {
      return res.status(400).json({ message: "No vehicles available in the system" });
    }
    const vehicleId = vehicleResult.rows[0][0];

    // ── Least-loaded agent ────────────────────────────────────────────────────
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

    // ── Insert consignment ────────────────────────────────────────────────────
    const insertResult = await connection.execute(
      `INSERT INTO consignment
         (customer_id, item_details, weight, dimensions, current_status, agent_id, vehicle_id, booking_date)
       VALUES
         (:customer_id, :item_details, :weight, :dimensions, 'Assigned', :agent_id, :vehicle_id, SYSDATE)
       RETURNING consignment_id INTO :new_id`,
      {
        customer_id: req.user.id,
        item_details,
        weight: Number(weight),
        dimensions: dimensions || null,
        agent_id: agentId,
        vehicle_id: vehicleId,
        new_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );
    const consignmentId = insertResult.outBinds.new_id[0];

    // ── Payment record (fare = weight × ₹20) ─────────────────────────────────
    await connection.execute(
      `INSERT INTO payment (consignment_id, payment_method, amount, payment_status, payment_date)
       VALUES (:consignment_id, :method, :amount, 'Paid', SYSDATE)`,
      { consignment_id: consignmentId, method: payment_method, amount: fare }
    );

    // ── Status trail ──────────────────────────────────────────────────────────
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
      message: "Consignment created, agent assigned, and payment recorded",
      consignmentId,
      fare,
      assignedAgent: agentId,
      assignedVehicle: vehicleId,
    });
  } catch (err) {
    console.error("CREATE CONSIGNMENT ERROR:", err);
    if (connection) await connection.rollback().catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /consignments/agent  — Agent dashboard with full customer & delivery info
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
         cu.name             AS customer_name,
         cu.phone_number     AS customer_phone,
         cu.email            AS customer_email,
         cu.pickup_address,
         cu.delivery_address,
         v.vehicle_number,
         v.vehicle_type,
         v.capacity,
         NVL((SELECT SUM(p.amount) FROM payment p
              WHERE p.consignment_id = c.consignment_id
              AND p.payment_status = 'Paid'), 0) AS amount_paid
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

    const agentResult = await connection.execute(
      `SELECT name, phone_number, email, availability_status FROM deliveryagent WHERE agent_id = :id`,
      { id: req.user.id }
    );
    const ar = agentResult.rows[0] || [];
    const agent = { name: ar[0], phone: ar[1], email: ar[2], availability: ar[3] };

    res.json({ toDeliver, delivered, agent });
  } catch (err) {
    console.error("GET /agent ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /consignments/:id  — Single consignment detail
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", verifyToken, async (req, res) => {
  let connection;
  try {
    connection = await connectDB();

    const result = await connection.execute(
      `SELECT
         c.consignment_id, c.item_details, c.weight, c.dimensions,
         c.current_status, c.booking_date,
         d.agent_id, d.name AS agent_name, d.phone_number AS agent_phone,
         v.vehicle_number, v.vehicle_type, v.capacity
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
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

module.exports = router;