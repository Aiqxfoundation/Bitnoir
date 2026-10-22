import { Router, type IRouter } from "express";
import accountsRouter from "./accounts";
import adminRouter from "./admin";
import adminFinanceRouter from "./admin-finance";
import activityRouter from "./activity";
import bnbRouter from "./bnb";
import bitsRouter from "./bits";
import configRouter from "./config";
import farmingRouter from "./farming";
import walletsRouter from "./wallets";

const router: IRouter = Router();

router.use(accountsRouter);
router.use(bitsRouter);
router.use(walletsRouter);
router.use(configRouter);
router.use(activityRouter);
router.use(bnbRouter);
router.use(farmingRouter);
router.use(adminRouter);
router.use(adminFinanceRouter);

export default router;
