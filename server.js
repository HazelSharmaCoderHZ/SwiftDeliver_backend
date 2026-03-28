require("dotenv").config(); // 🔥 VERY IMPORTANT

const express = require("express");
const cors = require("cors");
const oracledb = require("oracledb");

const app = express();

// ✅ Middleware FIRST
app.use(cors());
app.use(express.json());

// 🔥 Oracle DB Pool Setup
async function initializeDB() {
  try {
    await oracledb.createPool({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      connectString: process.env.DB_CONNECT_STRING,
    });

    console.log("✅ Oracle DB Connected");
  } catch (err) {
    console.error("❌ DB Connection Error:", err);
  }
}
const cors = require("cors");
app.use(cors());
// 🔥 Call DB init
initializeDB();
app.use("/api/payments", require("./routes/paymentRoutes"));
// ✅ Routes AFTER middleware
const customerRoutes = require("./routes/customerRoutes");
app.use("/customers", customerRoutes);
const agentRoutes = require("./routes/agentRoutes");
app.use("/agents", agentRoutes);
const consignmentRoutes = require("./routes/consignmentRoutes");
const statusRoutes = require("./routes/statusRoutes");
app.use("/api/status", statusRoutes);
app.use("/consignments", consignmentRoutes);
const authRoutes = require("./routes/authRoutes");
app.use("/api/auth", authRoutes);
app.use(cors({
  origin: "http://localhost:3000",
  credentials: true
}));
// ✅ Test route
app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));