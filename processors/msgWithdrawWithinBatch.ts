import bigDecimal from "js-big-decimal";
import { getDenominator } from "../utils/getDenominator";

export function msgWithdrawWithinBatch(baseDecimals: number, logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const log of logs) {
    for (const { type, attributes } of log.events) {
      if (type === "withdraw_within_batch") {
        const [, , , { value: denom }, { value: amount }] = attributes;
        transactions.push({
          description: "Remove from Liquidity Pool",
          sentAmount: bigDecimal.divide(
            amount,
            getDenominator(baseDecimals),
            baseDecimals
          ),
          sentAsset: denom,
        });
      }
    }
  }
  return transactions;
}
