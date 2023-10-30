import bigDecimal from "js-big-decimal";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { groupAttributesIntoBlocks } from "../utils/groupAttributesIntoBlocks";
import { getDenominator } from "../utils/getDenominator";

export async function msgAcknowledgement(logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];

  for (const { events } of logs) {
    for (const { type, attributes } of events) {
      if (type === "claim") {
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
                description: "Airdop",
                type: "Income",
              });
            }
          }
        }
      }
    }
  }

  return transactions;
}
