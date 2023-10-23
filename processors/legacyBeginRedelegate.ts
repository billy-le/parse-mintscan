import bigDecimal from "js-big-decimal";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getDenominator } from "../utils/getDenominator";
import { getValueOfKey } from "../utils/getValueOfKey";
import { getFees } from "../utils/getFees";

export async function legacyBeginRedelegate(
  baseSymbol: string,
  baseDecimals: number,
  tx: Tx,
  logs: Log[]
) {
  const transactions: Partial<Transaction>[] = [];
  for (const log of logs) {
    const redelegations = log.events.filter(
      ({ type }) => type === "redelegate"
    );

    for (const { attributes } of redelegations) {
      const source = getValueOfKey(attributes, "source_validator");
      const dest = getValueOfKey(attributes, "destination_validator");
      const amount = getValueOfKey(attributes, "amount");
      transactions.push({
        type: "Expense",
        description: `Redelgated ${bigDecimal.divide(
          amount?.value,
          getDenominator(baseDecimals),
          baseDecimals
        )} ATOM from ${source?.value} to ${dest?.value}`,
        feeAmount: await getFees(tx),
        feeAsset: baseSymbol,
      });
    }

    const transfers = log.events.filter(({ type }) => type === "transfer");

    for (const { attributes } of transfers) {
      const amount = attributes
        .filter(({ key }) => key === "amount")
        .reduce((sum, amount) => {
          const [[value, denom]] = getDenominationsValueList(amount.value);

          return bigDecimal.add(
            sum,
            bigDecimal.divide(value, getDenominator(baseDecimals), baseDecimals)
          );
        }, "0");

      transactions.push({
        type: "Income",
        receivedAmount: amount,
        receivedAsset: baseSymbol,
        description: "Claimed Rewards from Redelegating",
      });
    }
  }
  return transactions;
}
