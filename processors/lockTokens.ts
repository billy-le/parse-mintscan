import bigDecimal from "js-big-decimal";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getDenominator } from "../utils/getDenominator";
import { getFees } from "../utils/getFees";

export async function lockTokens(
  address: string,
  baseSymbol: string,
  tx: Tx,
  logs: Log[]
) {
  const transactions: Partial<Transaction>[] = [];
  for (const { events } of logs) {
    for (const { type, attributes } of events) {
      if (type === "lock_tokens") {
        const [
          { value: periodLockId },
          { value: owner },
          { value: amount },
          { value: duration },
          { value: unlockTime },
        ] = attributes;
        if (owner === address) {
          const regex = /\d+(.+)/;
          const [[_amount]] = getDenominationsValueList(amount);
          const tokenAmount = bigDecimal.divide(
            _amount,
            getDenominator(18),
            18
          );
          const denom = amount.match(regex)?.[1];
          transactions.push({
            type: "Expense",
            feeAmount: await getFees(tx),
            feeAsset: baseSymbol,
            description: `Bond ${tokenAmount} ${denom}`,
          });
        }
      }
    }
  }
  return transactions;
}
