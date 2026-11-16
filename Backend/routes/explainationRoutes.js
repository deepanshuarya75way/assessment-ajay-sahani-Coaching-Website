import express from "express";
import isAuthenticated from "../middlewares/isAuthenticated.js";
import { getExplanation, askFollowUp } from "../controllers/explanation.controller.js";

const router = express.Router();

router.post("/", isAuthenticated, getExplanation);

router.post("/follow-up", isAuthenticated, askFollowUp);

export default router;