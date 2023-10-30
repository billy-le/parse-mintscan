import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getDenominator } from "../utils/getDenominator";
import { getFees } from "../utils/getFees";
import { groupAttributesIntoBlocks } from "../utils/groupAttributesIntoBlocks";

export async function msgDelegate(baseSymbol: string, tx: Tx, logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const { events } of logs) {
    for (const { type, attributes } of events) {
      if (type === "delegate") {
        const amount = attributes.find(({ key }) => key === "amount");
        const denoms = amount
          ? getDenominationsValueList(amount.value)
          : [["0", "Unknown"]];
        for (const [amount, denom] of denoms) {
          const { symbol, decimals } = await getIbcDenomination(denom);
          const tokenAmount = bigDecimal.divide(
            amount,
            getDenominator(decimals),
            decimals
          );

          transactions.push({
            type: "Expense",
            description: `Delegated ${tokenAmount} ${symbol}`,
            feeAmount: await getFees(tx),
            feeAsset: baseSymbol,
          });
        }
      } else if (type === "claim") {
        const groups = groupAttributesIntoBlocks(attributes);
        for (const group of groups) {
          const amount = group.find(({ key }) => key === "amount");
          if (amount) {
            const denoms = getDenominationsValueList(amount.value);
            for (const [amount, denom] of denoms) {
              const { symbol, decimals } = await getIbcDenomination(denom);
              const tokenAmount = bigDecimal.divide(
                amount,
                getDenominator(decimals),
                decimals
              );
              transactions.push({
                receivedAmount: tokenAmount,
                receivedAsset: symbol,
                type: "Income",
                description: "Airdrop",
              });
            }
          }
        }
      }
    }
  }

  return transactions;
}
