const express = require("express");
const router = express.Router();
const { signup, login, agentLogin, agentSignup } = require("../controllers/authController");

router.post("/agent-signup", agentSignup);

router.post("/signup", signup);
router.post("/login", login);
router.post("/agent-login", agentLogin);

module.exports = router;