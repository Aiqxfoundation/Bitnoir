import { Router, type IRouter } from "express";
import { GetPublicConfigResponse } from "@workspace/api-zod";
import {
  areBnbOperationsEnabled,
  BNB_CHAIN_ID,
  BNB_MIN_CONFIRMATIONS,
  getTreasuryAddress,
  getWithdrawalFeeBps,
} from "../../lib/finance";

const router: IRouter = Router();

router.get("/config", (_req, res): void => {
  res.json(
    GetPublicConfigResponse.parse({
      bnbDepositsEnabled: areBnbOperationsEnabled(),
      treasuryAddress: getTreasuryAddress(),
      chainId: BNB_CHAIN_ID,
      minConfirmations: BNB_MIN_CONFIRMATIONS,
      withdrawalFeeBps: getWithdrawalFeeBps(),
    }),
  );
});

export default router;
