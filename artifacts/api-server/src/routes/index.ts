import { Router, type IRouter } from "express";
import healthRouter from "./health";
import runsRouter from "./runs";

const router: IRouter = Router();

router.use(healthRouter);
router.use(runsRouter);

export default router;
