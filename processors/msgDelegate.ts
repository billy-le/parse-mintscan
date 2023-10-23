import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getDenominator } from "../utils/getDenominator";
import { getFees } from "../utils/getFees";
import { getValueOfKey } from "../utils/getValueOfKey";

export async function msgDelegate(
  address: string,
  baseSymbol: string,
  tx: Tx,
  logs: Log[]
) {
  const transactions: Partial<Transaction>[] = [];
  for (const log of logs) {
    const delegates = log.events.filter(({ type }) => type === "delegate");
    for (const { attributes } of delegates) {
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
    }

    const transfers = log.events.filter(({ type }) => type == "transfer");

    for (const { attributes } of transfers) {
      const recipient = getValueOfKey(attributes, "recipient");
      if (recipient?.value === address) {
        const amount = getValueOfKey(attributes, "amount");
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
            type: "Income",
            description: "Claim Rewards from Delegating",
            receivedAmount: tokenAmount,
            receivedAsset: symbol,
          });
        }
      }
    }
  }

  return transactions;
}
