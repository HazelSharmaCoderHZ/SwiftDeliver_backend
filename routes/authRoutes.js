const express = require("express");
const router = express.Router();
const {
  signup,
  login,
  agentSignup,
  agentLogin,
  getProfile,
  updateProfile,
} = require("../controllers/authController");
const verifyToken = require("../middleware/authMiddleware");

// Customer auth
router.post("/signup", signup);
router.post("/login", login);

// Agent auth
router.post("/agent-signup", agentSignup);
router.post("/agent-login", agentLogin);

// Customer profile (protected)
router.get("/profile", verifyToken, getProfile);
router.put("/profile", verifyToken, updateProfile);

module.exports = router;