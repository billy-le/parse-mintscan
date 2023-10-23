import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getDenominator } from "../utils/getDenominator";
import { getValueOfKey } from "../utils/getValueOfKey";
import { getFees } from "../utils/getFees";

export async function legacySend(
  address: string,
  baseSymbol: string,
  tx: Tx,
  logs: Log[]
) {
  const transactions: Partial<Transaction>[] = [];
  for (const log of logs) {
    const transferInfo =
      log.events.find(({ type }) => type === "transfer")?.attributes ?? [];
    const recipient = getValueOfKey(transferInfo, "recipient");
    const sender = getValueOfKey(transferInfo, "sender");
    const amount = getValueOfKey(transferInfo, "amount");
    const denoms = amount
      ? getDenominationsValueList(amount?.value)
      : [["0", "Unknown"]];

    if (recipient?.value === address) {
      for (const [amount, denom] of denoms) {
        const tokenInfo = await getIbcDenomination(denom);
        const tokenAmount = bigDecimal.divide(
          amount,
          getDenominator(tokenInfo.decimals),
          tokenInfo.decimals
        );

        transactions.push({
          type: "Deposit",
          receivedAmount: tokenAmount,
          receivedAsset: tokenInfo.symbol,
          description: `Received from ${sender?.value}`,
        });
      }
    } else if (sender?.value === address) {
      for (const [amount, denom] of denoms) {
        const tokenInfo = await getIbcDenomination(denom);
        const tokenAmount = bigDecimal.divide(
          amount,
          getDenominator(tokenInfo.decimals),
          tokenInfo.decimals
        );

        transactions.push({
          type: "Transfer",
          receivedAmount: tokenAmount,
          receivedAsset: tokenInfo.symbol,
          description: `Sent to ${recipient?.value}`,
        });
      }

      transactions.push({
        type: "Expense",
        feeAmount: await getFees(tx),
        feeAsset: baseSymbol,
      });
    }
  }

  return transactions;
}
