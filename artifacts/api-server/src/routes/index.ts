import { Router, type IRouter } from "express";
import healthRouter from "./health";
import bitnoirRouter from "./bitnoir";

const router: IRouter = Router();

router.use(healthRouter);
router.use(bitnoirRouter);

export default router;
