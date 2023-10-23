import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominator } from "../utils/getDenominator";

export async function msgSwapWithinBatch(logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const log of logs) {
    const swaps = log.events.filter(({ type }) => type === "swap_within_batch");
    for (const {
      attributes: [
        ,
        ,
        ,
        ,
        { value: offerDenom },
        { value: offerAmount },
        { value: offerFee },
        { value: demandDenom },
        { value: orderPrice },
      ],
    } of swaps) {
      const { symbol: offerSymbol, decimals: offerDecimals } =
        await getIbcDenomination(offerDenom);
      const offer = bigDecimal.divide(
        offerAmount,
        getDenominator(offerDecimals),
        offerDecimals
      );
      const { symbol: demandSymbol, decimals: demandDecimals } =
        await getIbcDenomination(demandDenom);
      const demand = bigDecimal.divide(
        bigDecimal.multiply(offer, orderPrice),
        1,
        demandDecimals
      );
      transactions.push({
        type: "Swap",
        sentAmount: offer,
        sentAsset: offerSymbol,
        receivedAmount: demand,
        receivedAsset: demandSymbol,
        description: `Swap ${offer} ${offerSymbol} for ${demand} ${demandSymbol}`,
        feeAmount: bigDecimal.divide(
          offerFee,
          getDenominator(offerDecimals),
          offerDecimals
        ),
        feeAsset: offerSymbol,
      });
    }
  }

  return transactions;
}
