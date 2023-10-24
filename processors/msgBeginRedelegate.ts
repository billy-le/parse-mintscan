import bigDecimal from "js-big-decimal";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominator } from "../utils/getDenominator";
import { getFees } from "../utils/getFees";

export async function msgBeginRedelegate(
  address: string,
  baseSymbol: string,
  tx: Tx,
  logs: Log[]
) {
  const transactions: Partial<Transaction>[] = [];
  for (const log of logs) {
    for (const { type, attributes } of log.events) {
      if (type === "redelegate") {
        const [{ value: source }, { value: dest }, { value: amount }] =
          attributes;
        const denoms = getDenominationsValueList(amount);
        for (const [amount, denom] of denoms) {
          const { symbol, decimals } = await getIbcDenomination(denom);
          const tokenAmount = bigDecimal.divide(
            amount,
            getDenominator(decimals),
            decimals
          );
          transactions.push({
            description: `Redelegated ${tokenAmount} ${symbol} from ${source} to ${dest}`,
            feeAmount: await getFees(tx),
            feeAsset: baseSymbol,
            type: "Expense",
          });
        }
      }
      if (type === "transfer") {
        const keys = new Set<string>();
        attributes.forEach(({ key }) => keys.add(key));
        for (let i = 0; i < attributes.length; i += keys.size) {
          const [{ value: recipient }, , { value: amount }] = attributes.slice(
            i,
            (i += keys.size)
          );

          if (recipient === address) {
            const denoms = getDenominationsValueList(amount);
            for (const [amount, denom] of denoms) {
              const { symbol, decimals } = await getIbcDenomination(denom);
              transactions.push({
                type: "Income",
                description: `Claimed Rewards from Redelegating`,
                receivedAmount: bigDecimal.divide(
                  amount,
                  getDenominator(decimals),
                  decimals
                ),
                receivedAsset: symbol,
              });
            }
          }
        }
      }
    }
  }

  return transactions;
}
