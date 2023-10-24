import bigDecimal from "js-big-decimal";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { groupAttributesIntoBlocks } from "../utils/groupAttributesIntoBlocks";
import { getDenominator } from "../utils/getDenominator";

export async function msgMultiSend(address: string, logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const { events } of logs) {
    for (const { type, attributes } of events) {
      if (type === "transfer") {
        const groups = groupAttributesIntoBlocks(attributes);
        for (const [recipient, amount] of groups) {
          if (recipient.value === address) {
            const denoms = getDenominationsValueList(amount.value);
            for (const [amount, denom] of denoms) {
              const { symbol, decimals } = await getIbcDenomination(denom);
              const tokenAmount = bigDecimal.divide(
                amount,
                getDenominator(decimals),
                decimals
              );

              transactions.push({
                type: "Income",
                receivedAmount: tokenAmount,
                receivedAsset: symbol,
                description: `?`,
              });
            }
          }
        }
      }
    }
  }
  return transactions;
}
