import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getDenominator } from "../utils/getDenominator";
import { getFees } from "../utils/getFees";
import { getValueOfKey } from "../utils/getValueOfKey";

export async function msgSend(
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
              type: "Deposit",
              description: `Received from ${sender?.value}`,
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
              type: "Transfer",
              description: `Sent to ${recipient?.value}`,
              sentAmount: tokenAmount,
              sentAsset: symbol,
            });
          }

          transactions.push({
            type: "Expense",
            feeAmount: await getFees(tx),
            feeAsset: baseSymbol,
            description: "Fee for Transfer",
          });
        }
      }
    }
  }

  return transactions;
}
