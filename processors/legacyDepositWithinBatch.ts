import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getDenominator } from "../utils/getDenominator";
import { getValueOfKey } from "../utils/getValueOfKey";
import { getFees } from "../utils/getFees";

export async function legacyDepositWithinBatch(
  address: string,
  baseSymbol: string,
  tx: Tx,
  logs: Log[]
) {
  const transactions: Partial<Transaction>[] = [];
  for (const log of logs) {
    const transfers = log.events.filter(({ type }) => type === "transfer");

    if (transfers.length) {
      for (const { attributes } of transfers) {
        const recipient = getValueOfKey(attributes, "recipient");
        const sender = getValueOfKey(attributes, "sender");
        const amount = getValueOfKey(attributes, "amount");
        const denoms = amount
          ? getDenominationsValueList(amount.value)
          : [["0", "Unknown"]];

        if (recipient?.value === address) {
          for (const [amount, denom] of denoms) {
            const { symbol, decimals } = await getIbcDenomination(denom);
            const tokenAmount = bigDecimal.divide(
              amount,
              getDenominator(decimals),
              decimals
            );
            transactions.push({
              type: "Income",
              description: "Received from Liquidity Pool",
              receivedAmount: tokenAmount,
              receivedAsset: symbol,
            });
          }
        } else if (sender?.value === address) {
          for (const [amount, denom] of denoms) {
            const { symbol, decimals } = await getIbcDenomination(denom);
            const tokenAmount = bigDecimal.divide(
              amount,
              getDenominator(decimals),
              decimals
            );
            transactions.push({
              type: "Swap",
              description: "Add to Liquidity Pool",
              sentAmount: tokenAmount,
              sentAsset: symbol,
            });
          }

          transactions.push({
            type: "Expense",
            description: "Fee for adding to Liquidity Pool",
            feeAmount: await getFees(tx),
            feeAsset: baseSymbol,
          });
        }
      }
    }
  }

  return transactions;
}
