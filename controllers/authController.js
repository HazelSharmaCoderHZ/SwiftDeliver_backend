const oracledb = require("oracledb");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const connectDB = require("../db");

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER SIGNUP
// ─────────────────────────────────────────────────────────────────────────────
exports.signup = async (req, res) => {
  let connection;
  try {
    const { name, email, password, phone_number, pickup_address, delivery_address } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ message: "Name, email and password are required" });

    connection = await connectDB();

    const existing = await connection.execute(
      `SELECT customer_id FROM customer WHERE email = :email`, { email }
    );
    if (existing.rows.length > 0)
      return res.status(400).json({ message: "Email already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);

    await connection.execute(
      `INSERT INTO customer (name, email, password, phone_number, pickup_address, delivery_address)
       VALUES (:name, :email, :password, :phone, :pickup, :delivery)`,
      {
        name, email, password: hashedPassword,
        phone: phone_number || null,
        pickup: pickup_address || null,
        delivery: delivery_address || null,
      },
      { autoCommit: true }
    );

    res.status(201).json({ message: "Signup successful" });
  } catch (err) {
    console.error("SIGNUP ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER LOGIN
// ─────────────────────────────────────────────────────────────────────────────
exports.login = async (req, res) => {
  let connection;
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    connection = await connectDB();

    const result = await connection.execute(
      `SELECT customer_id, name, email, password FROM customer WHERE email = :email`, { email }
    );
    if (result.rows.length === 0)
      return res.status(401).json({ message: "Invalid credentials" });

    const [customer_id, name, userEmail, hashedPwd] = result.rows[0];
    const isMatch = await bcrypt.compare(password, hashedPwd);
    if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { id: customer_id, name, email: userEmail, role: "customer" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ message: "Login successful", token, name, role: "customer" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET CUSTOMER PROFILE
// ─────────────────────────────────────────────────────────────────────────────
exports.getProfile = async (req, res) => {
  let connection;
  try {
    connection = await connectDB();

    const result = await connection.execute(
      `SELECT customer_id, name, email, phone_number, pickup_address, delivery_address
       FROM customer WHERE customer_id = :id`,
      { id: req.user.id }
    );

    if (result.rows.length === 0)
      return res.status(404).json({ message: "Profile not found" });

    const [customer_id, name, email, phone_number, pickup_address_raw, delivery_address_raw] = result.rows[0];

    // Handle CLOB for addresses
    let pickup_address = pickup_address_raw;
    let delivery_address = delivery_address_raw;
    if (pickup_address_raw && typeof pickup_address_raw.getData === "function") {
      pickup_address = await pickup_address_raw.getData();
    }
    if (delivery_address_raw && typeof delivery_address_raw.getData === "function") {
      delivery_address = await delivery_address_raw.getData();
    }

    res.json({ customer_id, name, email, phone_number, pickup_address, delivery_address });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE CUSTOMER PROFILE
// ─────────────────────────────────────────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  let connection;
  try {
    const { name, phone_number, pickup_address, delivery_address } = req.body;

    connection = await connectDB();

    await connection.execute(
      `UPDATE customer
       SET name = :name,
           phone_number = :phone,
           pickup_address = :pickup,
           delivery_address = :delivery
       WHERE customer_id = :id`,
      {
        name: name || null,
        phone: phone_number || null,
        pickup: pickup_address || null,
        delivery: delivery_address || null,
        id: req.user.id,
      },
      { autoCommit: true }
    );

    res.json({ message: "Profile updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// AGENT SIGNUP
// ─────────────────────────────────────────────────────────────────────────────
exports.agentSignup = async (req, res) => {
  let connection;
  try {
    const { name, email, password, phone_number } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ message: "Name, email and password are required" });

    connection = await connectDB();

    const existing = await connection.execute(
      `SELECT agent_id FROM deliveryagent WHERE email = :email`, { email }
    );
    if (existing.rows.length > 0)
      return res.status(400).json({ message: "Agent already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);

    await connection.execute(
      `INSERT INTO deliveryagent (name, email, password, phone_number, availability_status)
       VALUES (:name, :email, :password, :phone, 'Available')`,
      { name, email, password: hashedPassword, phone: phone_number || null },
      { autoCommit: true }
    );

    res.status(201).json({ message: "Agent registered successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// AGENT LOGIN
// ─────────────────────────────────────────────────────────────────────────────
exports.agentLogin = async (req, res) => {
  let connection;
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    connection = await connectDB();

    const result = await connection.execute(
      `SELECT agent_id, name, email, password, availability_status
       FROM deliveryagent WHERE email = :email`,
      { email }
    );
    if (result.rows.length === 0)
      return res.status(401).json({ message: "Invalid credentials" });

    const [agent_id, name, agentEmail, hashedPwd, availability_status] = result.rows[0];
    const isMatch = await bcrypt.compare(password, hashedPwd);
    if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { id: agent_id, name, email: agentEmail, role: "agent" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ message: "Agent login successful", token, name, role: "agent", availability_status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
};