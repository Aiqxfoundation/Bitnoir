import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateFarmRewardEstimateWei,
  calculateWithdrawalAmounts,
  parseBnbAmount,
} from "./finance.ts";

test("parses BNB amounts without floating-point rounding", () => {
  assert.equal(parseBnbAmount("1.234567890123456789"), 1_234_567_890_123_456_789n);
  assert.equal(parseBnbAmount("0"), 0n);
  assert.equal(parseBnbAmount("1.0000000000000000001"), null);
});

test("calculates the disclosed 2% fee using integer wei", () => {
  const amountWei = 1_000_000_000_000_000_000n;
  assert.deepEqual(calculateWithdrawalAmounts(amountWei), {
    amountWei,
    feeWei: 20_000_000_000_000_000n,
    payoutWei: 980_000_000_000_000_000n,
  });
  assert.equal(
    calculateWithdrawalAmounts(amountWei, 500).feeWei,
    50_000_000_000_000_000n,
  );
  assert.deepEqual(calculateWithdrawalAmounts(1n), {
    amountWei: 1n,
    feeWei: 0n,
    payoutWei: 1n,
  });
  assert.throws(() => calculateWithdrawalAmounts(0n), RangeError);
  assert.throws(() => calculateWithdrawalAmounts(amountWei, 2_501), RangeError);
});

test("calculates farming projections with integer arithmetic", () => {
  assert.equal(
    calculateFarmRewardEstimateWei(1_000_000_000_000_000_000n, 10_000, 30),
    82_191_780_821_917_808n,
  );
  assert.equal(calculateFarmRewardEstimateWei(1n, 0, 15), 0n);
  assert.throws(() => calculateFarmRewardEstimateWei(1n, 10_001, 30), RangeError);
  assert.throws(() => calculateFarmRewardEstimateWei(1n, 100, 14), RangeError);
});
