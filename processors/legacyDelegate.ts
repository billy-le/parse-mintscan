import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getDenominator } from "../utils/getDenominator";
import { getFees } from "../utils/getFees";
import { getValueOfKey } from "../utils/getValueOfKey";

export async function legacyDelegate(
  address: string,
  baseDecimals: number,
  tx: Tx,
  logs: Log[]
) {
  const transactions: Partial<Transaction>[] = [];
  for (const log of logs) {
    const delegateAmount = log.events
      .find(({ type }) => type === "delegate")
      ?.attributes?.find(({ key }) => key === "amount");
    const [[amount, denom]] = delegateAmount
      ? getDenominationsValueList(delegateAmount.value)
      : ["0", "Unknown"];

    const tokenAmount = bigDecimal.divide(
      amount,
      getDenominator(baseDecimals),
      baseDecimals
    );

    transactions.push({
      type: "Expense",
      description: `Delegated ${tokenAmount} ATOM`,
      feeAmount: await getFees(tx),
    });

    const transferInfo =
      log.events.find(({ type }) => type === "transfer")?.attributes ?? [];
    if (transferInfo.length) {
      const receiver = getValueOfKey(transferInfo, "recipient");
      const amountInfo = getValueOfKey(transferInfo, "amount");
      const denoms = amountInfo
        ? getDenominationsValueList(amountInfo.value)
        : [["0", "Unknown"]];

      for (const [amount, denom] of denoms) {
        const tokenInfo = await getIbcDenomination(denom);
        const tokenAmount = bigDecimal.divide(
          amount,
          getDenominator(tokenInfo.decimals),
          tokenInfo.decimals
        );

        if (receiver?.value === address) {
          transactions.push({
            type: "Income",
            description: `Claimed ${tokenAmount} ${tokenInfo.symbol}`,
            receivedAmount: tokenAmount,
            receivedAsset: tokenInfo.symbol,
          });
        }
      }
    }
  }

  return transactions;
}
